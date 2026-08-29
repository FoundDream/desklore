import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import type { AppLocale, MessageKey } from "../../../../shared/i18n/index.js";
import { translate } from "../../../../shared/i18n/index.js";

interface I18nValue {
  locale: AppLocale;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | undefined>(undefined);

export function I18nProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  const t = useCallback(
    (key: MessageKey, values?: Record<string, string | number>) => translate(locale, key, values),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return <I18nContext.Provider value={{ locale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
