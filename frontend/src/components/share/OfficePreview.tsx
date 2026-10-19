import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { fetchFilePreviewSource } from "../../services/share.service";
import { openOfficeDocument } from "../../utils/officeDocumentPreview.util";
import {
  officeImageMime,
  type OfficeBlock,
  type OfficeDocument,
  type OfficeImage,
  type OfficePage,
  type OfficeRun,
  type OfficeTable,
} from "../../utils/officePreviewModel.util";
import { spreadsheetColumn } from "../../utils/spreadsheetPreview.util";
import styles from "./OfficePreview.module.css";

function Runs({ runs }: { runs: OfficeRun[] }) {
  return (
    <>
      {runs.map((run, index) => (
        <span key={index} style={run.style}>
          {run.text}
        </span>
      ))}
    </>
  );
}
function RasterImage({
  image,
  document,
  fr,
}: {
  image: OfficeImage;
  document: OfficeDocument;
  fr: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setSrc(null);
    setUnavailable(false);
    document
      .image(image.path, controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        const type = bytes && officeImageMime(bytes);
        if (!bytes || !type) {
          setUnavailable(true);
          return;
        }
        url = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type }),
        );
        setSrc(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [document, image.path]);
  if (!src)
    return (
      <span className={styles.imagePlaceholder}>
        {unavailable
          ? fr
            ? "Image non affichée"
            : "Image unavailable"
          : fr
            ? "Chargement de l’image"
            : "Loading image"}
      </span>
    );
  return (
    <img
      className={styles.image}
      src={src}
      alt={fr ? "Image du document" : "Document image"}
      style={{
        width: image.width,
        height: image.height,
        maxWidth: "100%",
        objectFit: "contain",
      }}
      onError={() => {
        setSrc(null);
        setUnavailable(true);
      }}
    />
  );
}
function StyledTable({ table }: { table: OfficeTable }) {
  const columns = Math.max(
    1,
    table.widths?.length ?? 0,
    ...table.rows.map((row) =>
      Math.max(
        row.cells.length,
        row.cells.reduce(
          (sum, cell) => sum + (cell.covered ? 0 : (cell.colSpan ?? 1)),
          0,
        ),
      ),
    ),
  );
  return (
    <table className={`${styles.table} ${table.grid ? styles.grid : ""}`}>
      <colgroup>
        {table.grid && <col style={{ width: 48 }} />}
        {Array.from({ length: columns }, (_, index) => (
          <col
            key={index}
            style={{
              width: table.widths?.[index] ?? (table.grid ? 110 : undefined),
            }}
          />
        ))}
      </colgroup>
      {table.grid && (
        <thead>
          <tr>
            <th aria-label="" />
            {Array.from({ length: columns }, (_, index) => (
              <th scope="col" key={index}>
                {spreadsheetColumn(index + (table.columnOffset ?? 0))}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {table.rows.map((row, index) => (
          <tr key={index} style={{ height: row.height }}>
            {table.grid && <th scope="row">{row.index ?? index + 1}</th>}
            {row.cells.map((cell, col) =>
              cell.covered ? null : (
                <td
                  key={col}
                  style={cell.style}
                  colSpan={
                    cell.colSpan
                      ? Math.max(1, Math.trunc(cell.colSpan))
                      : undefined
                  }
                  rowSpan={
                    cell.rowSpan
                      ? Math.max(1, Math.trunc(cell.rowSpan))
                      : undefined
                  }
                  title={cell.formula ? "=" + cell.formula : undefined}
                >
                  <Runs runs={cell.runs} />
                  {cell.runs.length === 0 && "\u00a0"}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function Block({
  block,
  document,
  fr,
}: {
  block: OfficeBlock;
  document: OfficeDocument;
  fr: boolean;
}) {
  if (block.kind === "image")
    return <RasterImage image={block} document={document} fr={fr} />;
  if (block.kind === "table") return <StyledTable table={block} />;
  const body = (
    <>
      {block.marker && <span className={styles.marker}>{block.marker}</span>}
      <Runs runs={block.runs} />
      {block.runs.length === 0 && "\u00a0"}
    </>
  );
  const Heading =
    block.heading === 1
      ? "h1"
      : block.heading === 2
        ? "h2"
        : block.heading === 3
          ? "h3"
          : "h4";
  return (
    <>
      {block.pageBreakBefore && <hr className={styles.pageBreak} />}
      {block.heading ? (
        <Heading className={styles.paragraph} style={block.style}>
          {body}
        </Heading>
      ) : (
        <p className={styles.paragraph} style={block.style}>
          {body}
        </p>
      )}
    </>
  );
}
export function OfficePageContent({
  page,
  document,
  fr,
}: {
  page: OfficePage;
  document: OfficeDocument;
  fr: boolean;
}) {
  return (
    <>
      {page.blocks.map((block, index) => (
        <Block key={index} block={block} document={document} fr={fr} />
      ))}
      {page.shapes?.map((shape, index) => (
        <div
          key={index}
          className={styles.shape}
          style={{
            ...shape.style,
            left: shape.x,
            top: shape.y,
            width: shape.width,
            height: shape.height,
            transform: shape.rotation
              ? `rotate(${shape.rotation}deg)`
              : undefined,
            borderRadius: shape.ellipse ? "50%" : undefined,
          }}
        >
          {shape.blocks.map((block, i) => (
            <Block key={i} block={block} document={document} fr={fr} />
          ))}
        </div>
      ))}
    </>
  );
}
function PageViewport({
  page,
  document,
  zoom,
  fr,
}: {
  page: OfficePage;
  document: OfficeDocument;
  zoom: string;
  fr: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [contentHeight, setContentHeight] = useState(page.height);
  useEffect(() => {
    const measure = () => {
      setAvailableWidth(
        Math.max(200, (viewport.current?.clientWidth ?? 600) - 32),
      );
      setContentHeight(canvas.current?.offsetHeight ?? page.height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (canvas.current) observer.observe(canvas.current);
    return () => observer.disconnect();
  }, [page]);
  const scale =
    zoom === "fit"
      ? Math.min(1.5, availableWidth / page.width)
      : Math.max(0.5, Math.min(2, Number(zoom) / 100));
  const workbook = document.kind === "workbook";
  return (
    <div
      ref={viewport}
      className={styles.viewport}
      tabIndex={0}
      aria-label={fr ? "Aperçu du document" : "Document preview"}
    >
      <div
        className={styles.scaled}
        style={{ width: page.width * scale, height: contentHeight * scale }}
      >
        <div
          ref={canvas}
          className={`${styles.paper} ${workbook ? styles.workbook : ""} ${document.kind === "presentation" ? styles.slide : ""}`}
          style={{
            width: page.width,
            minHeight: workbook ? undefined : page.height,
            height: document.kind === "presentation" ? page.height : undefined,
            backgroundColor: page.background ?? "#ffffff",
            transform: `scale(${scale})`,
            padding: page.padding
              ? page.padding.map((value) => value + "px").join(" ")
              : undefined,
          }}
        >
          <OfficePageContent page={page} document={document} fr={fr} />
          {!page.blocks.length && !page.shapes?.length && (
            <p>{fr ? "Aucun contenu à afficher." : "No content to display."}</p>
          )}
        </div>
      </div>
    </div>
  );
}
export default function OfficePreview({
  shareId,
  fileId,
  mimeType = "",
  e2eKey,
  onError,
}: {
  shareId: string;
  fileId: string;
  mimeType?: string;
  e2eKey?: string | null;
  onError: () => void;
}) {
  const intl = useIntl(),
    fr = intl.locale.startsWith("fr");
  const [document, setDocument] = useState<OfficeDocument | null>(null);
  const [page, setPage] = useState<OfficePage | null>(null);
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState("fit");
  useEffect(() => {
    const controller = new AbortController();
    setDocument(null);
    setPage(null);
    setIndex(0);
    (async () => {
      const source = await fetchFilePreviewSource(
        shareId,
        fileId,
        e2eKey,
        controller.signal,
      );
      const opened = await openOfficeDocument(
        source,
        controller.signal,
        mimeType,
        new DOMParser(),
        intl.locale,
      );
      if (!controller.signal.aborted) {
        setZoom(opened.kind === "workbook" ? "100" : "fit");
        setDocument(opened);
      }
    })().catch(() => {
      if (!controller.signal.aborted) onError();
    });
    return () => controller.abort();
  }, [shareId, fileId, mimeType, e2eKey, intl.locale, onError]);
  useEffect(() => {
    if (!document) return;
    const controller = new AbortController();
    setPage(null);
    document
      .load(index, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setPage(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) onError();
      });
    return () => controller.abort();
  }, [document, index, onError]);
  if (!document)
    return (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="end" wrap="wrap">
        {document.kind === "workbook" && (
          <Select
            w={220}
            label={fr ? "Feuille" : "Sheet"}
            aria-label={fr ? "Feuille" : "Sheet"}
            value={String(index)}
            data={document.units.map((unit, i) => ({
              value: String(i),
              label: unit.name || `${fr ? "Feuille" : "Sheet"} ${i + 1}`,
            }))}
            allowDeselect={false}
            onChange={(value) => {
              if (value !== null) setIndex(Number(value));
            }}
          />
        )}
        {document.kind === "presentation" && (
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              disabled={index === 0}
              onClick={() => setIndex((i) => i - 1)}
            >
              {fr ? "Précédente" : "Previous"}
            </Button>
            <Text size="sm">
              {fr ? "Diapositive" : "Slide"} {index + 1} /{" "}
              {document.units.length}
            </Text>
            <Button
              size="xs"
              variant="default"
              disabled={index + 1 >= document.units.length}
              onClick={() => setIndex((i) => i + 1)}
            >
              {fr ? "Suivante" : "Next"}
            </Button>
          </Group>
        )}
        <Select
          w={120}
          label="Zoom"
          aria-label="Zoom"
          value={zoom}
          allowDeselect={false}
          data={[
            { value: "fit", label: fr ? "Ajuster" : "Fit" },
            ...[50, 75, 100, 125, 150, 200].map((value) => ({
              value: String(value),
              label: value + " %",
            })),
          ]}
          onChange={(value) => {
            if (value) setZoom(value);
          }}
        />
      </Group>
      <Text size="xs" c="dimmed">
        {fr
          ? "Les polices et certains éléments avancés peuvent différer du document original."
          : "Fonts and some advanced elements may differ from the original document."}
      </Text>
      {page?.truncated && (
        <Alert>
          {fr
            ? "Aperçu partiel. Téléchargez le fichier pour consulter tout le contenu."
            : "Partial preview. Download the file to view all content."}
        </Alert>
      )}
      {page ? (
        <PageViewport
          key={index}
          page={page}
          document={document}
          zoom={zoom}
          fr={fr}
        />
      ) : (
        <Center mih={200}>
          <Loader />
        </Center>
      )}
    </Stack>
  );
}
