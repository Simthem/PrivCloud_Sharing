import { Anchor, Button, Container, Stack, Text, Title } from "@mantine/core";
import Head from "next/head";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import useTranslate from "../../hooks/useTranslate.hook";
import api from "../../services/api.service";

type Status = "idle" | "busy" | "done" | "invalid";

const ConfirmLinkPage = () => {
  const t = useTranslate();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    const value = new URLSearchParams(
      window.location.hash.replace(/^#/, ""),
    ).get("token");
    if (value) setToken(value);
    else setStatus("invalid");
  }, []);

  const confirm = async () => {
    setStatus("busy");
    try {
      await api.post("oauth/link/confirm", { token });
      setStatus("done");
    } catch {
      setStatus("invalid");
    }
  };

  const finished = status === "done" || status === "invalid";

  return (
    <>
      <Meta title={t("auth.confirmLink.title")} />
      <Head>
        <meta name="robots" content="noindex" />
      </Head>
      <Container size="xs" py="xl">
        <Stack>
          <Title order={2}>
            <FormattedMessage id="auth.confirmLink.title" />
          </Title>
          {status === "done" && (
            <Text>
              <FormattedMessage id="auth.confirmLink.success" />
            </Text>
          )}
          {status === "invalid" && (
            <Text c="red">
              <FormattedMessage id="auth.confirmLink.invalid" />
            </Text>
          )}
          {!finished && (
            <>
              <Text>
                <FormattedMessage id="auth.confirmLink.description" />
              </Text>
              <Button
                onClick={confirm}
                loading={status === "busy"}
                disabled={!token}
              >
                <FormattedMessage id="auth.confirmLink.confirm" />
              </Button>
            </>
          )}
          {finished && (
            <Anchor component={Link} href="/auth/signIn">
              <FormattedMessage id="auth.confirmLink.signIn" />
            </Anchor>
          )}
        </Stack>
      </Container>
    </>
  );
};

export default ConfirmLinkPage;
