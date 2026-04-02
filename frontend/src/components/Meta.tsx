import Head from "next/head";
import useConfig from "../hooks/config.hook";

const Meta = ({
  title,
  description,
}: {
  title: string;
  description?: string;
}) => {
  const config = useConfig();

  const metaTitle = `${title} - ${config.get("general.appName")}`;
  const metaDescription =
    description ??
    config.get("general.metaDescription") ??
    "A self-hosted and privacy-focused file sharing platform.";

  return (
    <Head>
      <title>{metaTitle}</title>
      <meta name="og:title" content={metaTitle} />
      <meta name="og:description" content={metaDescription} />
      <meta name="description" content={metaDescription} />
      <meta name="twitter:title" content={metaTitle} />
      <meta name="twitter:description" content={metaDescription} />
    </Head>
  );
};

export default Meta;
