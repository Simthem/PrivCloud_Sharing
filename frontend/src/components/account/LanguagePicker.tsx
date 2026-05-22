import { Select } from "@mantine/core";
import { getCookie, setCookie } from "cookies-next";
import { useRouter } from "next/router";
import { useState } from "react";
import useTranslate from "../../hooks/useTranslate.hook";
import { LOCALES } from "../../i18n/locales";

const LanguagePicker = () => {
  const t = useTranslate();
  const router = useRouter();
  const [selectedLanguage, setSelectedLanguage] = useState(
    getCookie("language")?.toString(),
  );

  const languages = Object.values(LOCALES).map((locale) => ({
    value: locale.code,
    label: locale.name,
  }));
  return (
    <Select
      value={selectedLanguage}
      description={t("account.card.language.description")}
      onChange={(value) => {
        setSelectedLanguage(value ?? "en");
        setCookie("language", value, {
          sameSite: "lax",
          expires: new Date(
            new Date().setFullYear(new Date().getFullYear() + 1),
          ),
        });
        // Switch URL locale for SEO languages (fr/en), reload for others
        const targetLocale = value?.startsWith("en") ? "en" : "fr";
        if (targetLocale !== router.locale) {
          const prefix = targetLocale === "en" ? "/en" : "";
          window.location.href = `${prefix}${router.asPath}`;
        } else {
          location.reload();
        }
      }}
      data={languages}
    />
  );
};

export default LanguagePicker;
