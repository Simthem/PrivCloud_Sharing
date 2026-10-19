import {
  Button,
  CopyButton,
  Group,
  Text,
  useComputedColorScheme,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import {
  CODE_HIGHLIGHT_MAX_CHARS,
  type CodeHighlight,
} from "../../utils/codePreview.util";
import { highlightCodePreview } from "../../utils/codeHighlightPreview.util";
import styles from "./SourceCodePreview.module.css";

const SourceCodePreview = ({
  text,
  language,
  partial = false,
}: {
  text: string;
  language: string | null;
  partial?: boolean;
}) => {
  const colorScheme = useComputedColorScheme("light", {
    getInitialValueInEffect: true,
  });
  const [highlight, setHighlight] = useState<CodeHighlight | null>(null);
  const [wrap, setWrap] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setHighlight(null);
    if (language) {
      highlightCodePreview(text, language, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setHighlight(result);
        })
        .catch(() => {});
    }
    return () => controller.abort();
  }, [text, language]);
  return (
    <>
      <Group justify="flex-end" gap="xs" mb="xs">
        <Button
          variant="subtle"
          size="compact-xs"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          <FormattedMessage id="share.modal.file-preview.word-wrap" />
        </Button>
        <CopyButton value={text} timeout={1500}>
          {({ copied, copy }) => (
            <Button variant="subtle" size="compact-xs" onClick={copy}>
              <FormattedMessage
                id={
                  copied
                    ? "share.modal.file-preview.copied"
                    : "share.modal.file-preview.copy-source"
                }
              />
            </Button>
          )}
        </CopyButton>
      </Group>
      <pre className={styles.source} data-theme={colorScheme} data-wrap={wrap}>
        <code data-language={language || "plaintext"}>
          {highlight ? (
            <>
              {highlight.tokens.map((token, index) =>
                token.classes.length ? (
                  <span key={index} className={token.classes.join(" ")}>
                    {token.text}
                  </span>
                ) : (
                  token.text
                ),
              )}
              {highlight.limited && text.slice(CODE_HIGHLIGHT_MAX_CHARS)}
            </>
          ) : (
            text
          )}
        </code>
      </pre>
      {partial && (
        <Text size="xs" c="dimmed" mt="xs">
          <FormattedMessage id="share.modal.file-preview.partial" />
        </Text>
      )}
      {highlight?.limited && (
        <Text size="xs" c="dimmed" mt="xs">
          <FormattedMessage id="share.modal.file-preview.highlight-limited" />
        </Text>
      )}
    </>
  );
};
export default SourceCodePreview;
