import Head from "next/head";
import { useRouter } from "next/router";
import { useIntl } from "react-intl";
import useConfig from "../hooks/config.hook";

const ORIGIN = "https://share.privcloud.fr";

const Meta = ({
  title,
  description,
}: {
  title: string;
  description?: string;
}) => {
  const config = useConfig();
  const { asPath } = useRouter();
  const { locale } = useIntl();

  const metaTitle = `${title} - ${config.get("general.appName")}`;
  const configDescription = locale?.startsWith("fr")
    ? config.get("general.metaDescriptionFr")
    : config.get("general.metaDescriptionEn");
  const metaDescription = description ?? configDescription;

  // Canonical: strip query string and trailing slash, keep origin clean
  const cleanPath = asPath.split("?")[0].split("#")[0].replace(/\/$/, "");
  const canonical = `${ORIGIN}${cleanPath}`;

  return (
    <Head>
      <title>{metaTitle}</title>
      <link rel="canonical" href={canonical} />
      <link rel="alternate" hrefLang="fr" href={canonical} />
      <link rel="alternate" hrefLang="en" href={canonical} />
      <link rel="alternate" hrefLang="x-default" href={canonical} />
      <meta name="og:title" content={metaTitle} />
      <meta name="og:description" content={metaDescription} />
      <meta property="og:url" content={canonical} />
      <meta name="description" content={metaDescription} />
      <meta name="twitter:title" content={metaTitle} />
      <meta name="twitter:description" content={metaDescription} />
    </Head>
  );
};

export default Meta;
