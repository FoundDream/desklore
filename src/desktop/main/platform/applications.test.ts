import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverInstalledApplications,
  parseMDLSApplicationMetadata,
  readICNSIconDataURL,
  resolveApplicationIconPath,
} from "./applications.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("installed application discovery", () => {
  it("parses the null-delimited Spotlight metadata shape", () => {
    expect(
      parseMDLSApplicationMetadata(
        "com.example.editor\u0000Example Editor\u0000Example Editor.app\u0000",
        "/Applications/Example Editor.app",
      ),
    ).toEqual({
      bundleIdentifier: "com.example.editor",
      name: "Example Editor",
    });
    expect(
      parseMDLSApplicationMetadata(
        "\u0000Missing Identifier\u0000Missing.app\u0000",
        "/Applications/Missing.app",
      ),
    ).toBeUndefined();
  });

  it("resolves the bundle icon and extracts a compact PNG representation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-application-icon-"));
    temporaryDirectories.push(root);
    const applicationPath = path.join(root, "Example.app");
    const resourcesPath = path.join(applicationPath, "Contents", "Resources");
    const iconPath = path.join(resourcesPath, "ExampleIcon.icns");
    await mkdir(resourcesPath, { recursive: true });

    const compactPNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("compact"),
    ]);
    const largePNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("large"),
    ]);
    const chunk = (type: string, payload: Buffer): Buffer => {
      const header = Buffer.alloc(8);
      header.write(type, 0, "ascii");
      header.writeUInt32BE(payload.length + 8, 4);
      return Buffer.concat([header, payload]);
    };
    const body = Buffer.concat([chunk("ic13", largePNG), chunk("ic11", compactPNG)]);
    const header = Buffer.alloc(8);
    header.write("icns", 0, "ascii");
    header.writeUInt32BE(body.length + 8, 4);
    await writeFile(iconPath, Buffer.concat([header, body]));

    await expect(resolveApplicationIconPath(applicationPath, ["ExampleIcon"])).resolves.toBe(
      iconPath,
    );
    await expect(readICNSIconDataURL(iconPath)).resolves.toBe(
      `data:image/png;base64,${compactPNG.toString("base64")}`,
    );
  });

  it("discovers top-level app bundles, skips nested helpers, and deduplicates bundle IDs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-applications-"));
    temporaryDirectories.push(root);
    const primary = path.join(root, "Applications");
    const secondary = path.join(root, "System Applications");
    const editor = path.join(primary, "Editor.app");
    const nestedHelper = path.join(editor, "Contents", "Frameworks", "Editor Helper.app");
    const notes = path.join(primary, "Productivity", "Notes.app");
    const duplicateEditor = path.join(secondary, "Editor Copy.app");
    const desklore = path.join(primary, "DeskLore.app");
    await Promise.all(
      [nestedHelper, notes, duplicateEditor, desklore].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    const metadata = new Map([
      [
        editor,
        {
          bundleIdentifier: "com.example.editor",
          name: "Editor",
          iconPath: path.join(editor, "Contents", "Resources", "Editor.icns"),
        },
      ],
      [nestedHelper, { bundleIdentifier: "com.example.editor.helper", name: "Helper" }],
      [notes, { bundleIdentifier: "com.example.notes", name: "Notes" }],
      [duplicateEditor, { bundleIdentifier: "com.example.editor", name: "Editor Copy" }],
      [desklore, { bundleIdentifier: "com.desklore.desktop", name: "DeskLore" }],
    ]);

    await expect(
      discoverInstalledApplications({
        roots: [primary, secondary],
        readMetadata: async (applicationPath) => metadata.get(applicationPath),
      }),
    ).resolves.toEqual([
      {
        bundleIdentifier: "com.example.editor",
        name: "Editor",
        applicationPath: editor,
        iconPath: path.join(editor, "Contents", "Resources", "Editor.icns"),
      },
      {
        bundleIdentifier: "com.example.notes",
        name: "Notes",
        applicationPath: notes,
      },
    ]);
  });
});
