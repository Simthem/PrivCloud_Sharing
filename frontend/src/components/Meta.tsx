import Head from "next/head";
import { useRouter } from "next/router";
import { useIntl } from "react-intl";
import useConfig from "../hooks/config.hook";

const ORIGIN = "https://share.privcloud.fr";

const Meta = ({
  title,
  description,
  ogType = "website",
  ogImage,
  noIndex = false,
}: {
  title: string;
  description?: string;
  ogType?: string;
  ogImage?: string;
  noIndex?: boolean;
}) => {
  const config = useConfig();
  const { asPath, locale: urlLocale } = useRouter();
  const { locale } = useIntl();

  const metaTitle = `${title} - ${config.get("general.appName")}`;
  const configDescription = locale?.startsWith("fr")
    ? config.get("general.metaDescriptionFr")
    : config.get("general.metaDescriptionEn");
  const metaDescription = description ?? configDescription;

  // Canonical: strip query string and trailing slash, keep origin clean
  const cleanPath = asPath.split("?")[0].split("#")[0].replace(/\/$/, "");
  const frUrl = `${ORIGIN}${cleanPath}`;
  const enUrl = `${ORIGIN}/en${cleanPath}`;
  const canonical = urlLocale === "en" ? enUrl : frUrl;

  const resolvedOgImage = ogImage
    ? `${ORIGIN}${ogImage}`
    : `${ORIGIN}/img/logo.png`;
  const ogLocale = urlLocale === "en" ? "en_US" : "fr_FR";
  const siteName = config.get("general.appName");

  return (
    <Head>
      <title>{metaTitle}</title>
      <meta name="robots" content={noIndex ? "noindex, nofollow" : "index, follow"} />
      <link rel="canonical" href={canonical} />
      {!noIndex && (
        <>
          <link rel="alternate" hrefLang="fr" href={frUrl} />
          <link rel="alternate" hrefLang="en" href={enUrl} />
          <link rel="alternate" hrefLang="x-default" href={frUrl} />
        </>
      )}
      <meta name="description" content={metaDescription} />

      {/* Open Graph */}
      <meta property="og:title" content={metaTitle} />
      <meta property="og:description" content={metaDescription} />
      <meta property="og:url" content={canonical} />
      <meta property="og:type" content={ogType} />
      <meta property="og:image" content={resolvedOgImage} />
      <meta property="og:site_name" content={siteName} />
      <meta property="og:locale" content={ogLocale} />
      <meta property="og:locale:alternate" content={urlLocale === "en" ? "fr_FR" : "en_US"} />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={metaTitle} />
      <meta name="twitter:description" content={metaDescription} />
      <meta name="twitter:image" content={resolvedOgImage} />

      {/* Article-specific OG tags -- emit only when ogType="article".
          Helps Google / Facebook / LinkedIn surface author + dates on
          shared blog posts. */}
      {ogType === "article" && (
        <>
          <meta property="article:author" content="Simon Thémiot" />
          <meta property="article:publisher" content="https://www.stprive.net/" />
        </>
      )}
    </Head>
  );
};

export default Meta;
