import { Anchor, Divider, Title, useMantineColorScheme } from "@mantine/core";
import DOMPurify from "isomorphic-dompurify";
import { useIntl } from "react-intl";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import useTranslate from "../../hooks/useTranslate.hook";
import useConfig from "../../hooks/config.hook";
import dynamic from "next/dynamic";
const Markdown = dynamic(() => import("markdown-to-jsx"), { ssr: false });

const PrivacyPolicy = () => {
  const t = useTranslate();
  const intl = useIntl();
  const isFr = intl.locale?.startsWith("fr") ?? true;
  const { colorScheme } = useMantineColorScheme();
  const config = useConfig();
  const metaDesc =
    config.get("legal.metaDescriptionPrivacy") || t("privacy.meta.description");

  // Sanitize Markdown content to prevent stored XSS via admin-controlled text
  const rawMarkdown = config.get("legal.privacyPolicyText") || "";
  const sanitizedMarkdown = DOMPurify.sanitize(rawMarkdown, {
    ALLOWED_TAGS: [], // Strip ALL HTML tags - only pure Markdown syntax is kept
    KEEP_CONTENT: true, // Keep text content, just strip the tags
  });
  return (
    <>
      <Meta title={t("privacy.title")} description={metaDesc} />
      <Title mb={30} order={1}>
        <FormattedMessage id="privacy.title" />
      </Title>
      <Markdown
        options={{
          forceBlock: true,
          overrides: {
            h1: {
              component: ({ children, ...props }: any) => (
                <Title order={2} mt="lg" mb="sm" {...props}>{children}</Title>
              ),
            },
            pre: {
              props: {
                style: {
                  backgroundColor:
                    colorScheme == "dark"
                      ? "rgba(50, 50, 50, 0.5)"
                      : "rgba(220, 220, 220, 0.5)",
                  padding: "0.75em",
                  whiteSpace: "pre-wrap",
                },
              },
            },
            table: {
              props: {
                className: "md",
              },
            },
            a: {
              props: {
                target: "_blank",
                rel: "noreferrer",
              },
              component: Anchor,
            },
          },
        }}
      >
        {sanitizedMarkdown}
      </Markdown>

      <Divider my="xl" />
    </>
  );
};

export default PrivacyPolicy;
