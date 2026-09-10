import {
  Alert,
  Box,
  Button,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
  UnstyledButton,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useEffect, useMemo, useState } from "react";
import { TbAlertTriangle, TbChartLine, TbRefresh } from "react-icons/tb";
import { FormattedMessage, useIntl } from "react-intl";
import useTranslate from "../../../hooks/useTranslate.hook";
import adminStatsService from "../../../services/adminStats.service";
import { UsageSeries } from "../../../types/adminStats.type";
import dayjs from "../../../utils/dayjs";
import { byteToHumanSizeString } from "../../../utils/fileSize.util";
import {
  axisMaximum,
  buildPathSegments,
  ChartPoint,
  closeAreaPath,
  isolatedPointIndexes,
  nearestIndex,
  pickTickIndexes,
  toPlottableBytes,
  UsageMetricKey,
} from "./usageChart.util";

const CHART_HEIGHT = 300;
const HORIZONTAL_GRID_LINES = 4;
const AXIS_GUTTER = 56;
const EDGE_GUTTER = 14;
const MOBILE_EDGE_GUTTER = 6;

const METRICS: {
  key: UsageMetricKey;
  color: MetricColor;
  labelId: string;
}[] = [
  { key: "users", color: "blue", labelId: "admin.stats.metric.users" },
  { key: "shares", color: "grape", labelId: "admin.stats.metric.shares" },
  { key: "views", color: "orange", labelId: "admin.stats.metric.views" },
  { key: "storage", color: "teal", labelId: "admin.stats.metric.storage" },
];

const RANGES = [1, 2, 6, 12];

type MetricColor = "blue" | "grape" | "orange" | "teal";

const UsageChart = () => {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme("light");
  const intl = useIntl();
  const t = useTranslate();
  const { ref, width } = useElementSize();

  const [months, setMonths] = useState(6);
  const [series, setSeries] = useState<UsageSeries | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasFailed, setHasFailed] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [activeMetrics, setActiveMetrics] = useState<UsageMetricKey[]>(
    METRICS.map((metric) => metric.key),
  );

  useEffect(() => {
    let isCurrent = true;
    setIsLoading(true);
    setHasFailed(false);
    setHoveredIndex(null);

    adminStatsService
      .getUsage(months)
      .then((usage) => {
        if (!isCurrent) return;
        setSeries(usage);
        setHoveredIndex(null);
      })
      .catch(() => {
        if (isCurrent) setHasFailed(true);
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [months, requestVersion]);

  // Curves with unrelated units share one plotting area, so each is scaled
  // against its own maximum. The tiles and the tooltip carry the real figures.
  const metricSeries = useMemo(() => {
    const points = series?.points ?? [];

    return METRICS.map((metric) => {
      const values: ChartPoint[] = points.map((point) => ({
        value:
          metric.key === "users"
            ? point.users
            : metric.key === "shares"
              ? point.shares
              : metric.key === "views"
                ? point.views
                : toPlottableBytes(point.storageBytes),
        estimated: point.estimated,
      }));

      const max = values.reduce(
        (highest, { value }) =>
          value !== null && value > highest ? value : highest,
        0,
      );

      return {
        ...metric,
        values,
        max: axisMaximum(max, HORIZONTAL_GRID_LINES, metric.key !== "storage"),
      };
    });
  }, [series]);

  const shownMetrics = metricSeries.filter((metric) =>
    activeMetrics.includes(metric.key),
  );

  const toggleMetric = (key: UsageMetricKey) => {
    setActiveMetrics((current) => {
      if (!current.includes(key)) {
        // Keep the declared order so the axes never swap sides on a toggle.
        return METRICS.filter(
          (metric) => metric.key === key || current.includes(metric.key),
        ).map((metric) => metric.key);
      }

      // An empty chart says nothing: the last active curve stays on.
      return current.length === 1 ? current : current.filter((m) => m !== key);
    });
  };

  const formatValue = (key: UsageMetricKey, value: number) =>
    key === "storage"
      ? byteToHumanSizeString(value)
      : intl.formatNumber(value, {
          notation: value >= 10_000 ? "compact" : "standard",
          maximumFractionDigits: 1,
        });

  const shade = (color: MetricColor) =>
    theme.colors[color][colorScheme === "dark" ? 4 : 6];

  const points = series?.points ?? [];
  // useElementSize starts at zero, but once measured the SVG must follow the
  // real container width. A hard 320 px floor overflowed narrow phones.
  const chartWidth = width > 0 ? width : 320;
  const isCompact = chartWidth < 560;
  // Exact values remain available in the tiles and tooltip. On narrow screens
  // hiding the vertical labels recovers the space both axis gutters consumed.
  const leftGutter = isCompact
    ? MOBILE_EDGE_GUTTER
    : shownMetrics.length >= 1
      ? AXIS_GUTTER
      : EDGE_GUTTER;
  const rightGutter = isCompact
    ? MOBILE_EDGE_GUTTER
    : shownMetrics.length >= 2
      ? AXIS_GUTTER
      : EDGE_GUTTER;
  const plotWidth = Math.max(chartWidth - leftGutter - rightGutter, 1);
  const plotHeight = CHART_HEIGHT - 44;

  const x = (index: number) =>
    leftGutter +
    (points.length <= 1
      ? plotWidth / 2
      : (index / (points.length - 1)) * plotWidth);

  const scaleY = (value: number, max: number) =>
    plotHeight - (Math.min(value, max) / max) * plotHeight + 12;

  const xTicks = pickTickIndexes(points.length, chartWidth < 560 ? 4 : 7);
  const gridRatios = Array.from(
    { length: HORIZONTAL_GRID_LINES + 1 },
    (_, index) => index / HORIZONTAL_GRID_LINES,
  );

  const gridColor =
    colorScheme === "dark" ? theme.colors.dark[4] : theme.colors.gray[3];
  const axisTextColor =
    colorScheme === "dark" ? theme.colors.dark[1] : theme.colors.gray[6];

  const readPointer = (clientX: number, target: SVGSVGElement) => {
    const bounds = target.getBoundingClientRect();
    setHoveredIndex(
      nearestIndex(clientX - bounds.left, leftGutter, plotWidth, points.length),
    );
  };

  const hoveredPoint = hoveredIndex !== null ? points[hoveredIndex] : undefined;

  return (
    <Paper withBorder p={{ base: "xs", sm: "lg" }}>
      <Group
        justify="space-between"
        align="center"
        mb="md"
        wrap="wrap"
        gap="sm"
      >
        <Group gap={8}>
          <TbChartLine size={20} color={theme.colors[theme.primaryColor][6]} />
          <Title order={4}>
            <FormattedMessage id="admin.stats.title" />
          </Title>
        </Group>
        <SegmentedControl
          size="xs"
          value={String(months)}
          onChange={(value) => setMonths(Number(value))}
          data={RANGES.map((range) => ({
            value: String(range),
            label: t("admin.stats.range.months", { count: range }),
          }))}
        />
      </Group>

      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="xs" mb="lg">
        {metricSeries.map((metric) => {
          const isActive = activeMetrics.includes(metric.key);
          const total =
            metric.key === "users"
              ? (series?.totals.users ?? 0)
              : metric.key === "shares"
                ? (series?.totals.shares ?? 0)
                : metric.key === "views"
                  ? (series?.totals.views ?? 0)
                  : (toPlottableBytes(series?.totals.storageBytes ?? "0") ?? 0);

          return (
            <UnstyledButton
              key={metric.key}
              onClick={() => toggleMetric(metric.key)}
              aria-pressed={isActive}
            >
              <Paper
                withBorder
                p="sm"
                style={{
                  borderTopWidth: 3,
                  borderTopColor: isActive
                    ? shade(metric.color)
                    : "transparent",
                  opacity: isActive ? 1 : 0.55,
                }}
              >
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  <FormattedMessage id={metric.labelId} />
                </Text>
                {isLoading ? (
                  <Skeleton height={26} width="60%" mt={6} />
                ) : (
                  <Text
                    size="xl"
                    fw={700}
                    mt={2}
                    aria-label={
                      hasFailed || !series
                        ? t("admin.stats.unavailable")
                        : undefined
                    }
                  >
                    {hasFailed || !series
                      ? "—"
                      : formatValue(metric.key, total)}
                  </Text>
                )}
              </Paper>
            </UnstyledButton>
          );
        })}
      </SimpleGrid>

      <Box ref={ref} style={{ position: "relative" }}>
        {isLoading && <Skeleton height={CHART_HEIGHT} radius="sm" />}

        {!isLoading && hasFailed && (
          <Alert
            color="orange"
            variant="light"
            icon={<TbAlertTriangle size={18} />}
          >
            <Group justify="space-between" align="center" wrap="wrap">
              <FormattedMessage id="admin.stats.error" />
              <Button
                size="compact-xs"
                variant="subtle"
                color="orange"
                leftSection={<TbRefresh size={14} />}
                onClick={() => setRequestVersion((current) => current + 1)}
              >
                <FormattedMessage id="common.button.retry" />
              </Button>
            </Group>
          </Alert>
        )}

        {!isLoading && !hasFailed && points.length > 0 && (
          <svg
            width={chartWidth}
            height={CHART_HEIGHT}
            role="img"
            aria-label={t("admin.stats.aria", {
              from: dayjs(series?.from).format("LL"),
              to: dayjs(series?.to).format("LL"),
            })}
            style={{ display: "block", touchAction: "pan-y" }}
            onMouseMove={(event) =>
              readPointer(event.clientX, event.currentTarget)
            }
            onMouseLeave={() => setHoveredIndex(null)}
            onTouchStart={(event) =>
              readPointer(event.touches[0].clientX, event.currentTarget)
            }
            onTouchMove={(event) =>
              readPointer(event.touches[0].clientX, event.currentTarget)
            }
            onTouchEnd={() => setHoveredIndex(null)}
          >
            {gridRatios.map((ratio) => {
              const y = 12 + plotHeight * ratio;
              return (
                <g key={ratio}>
                  <line
                    x1={leftGutter}
                    x2={leftGutter + plotWidth}
                    y1={y}
                    y2={y}
                    stroke={gridColor}
                    strokeWidth={1}
                  />
                  {!isCompact && shownMetrics[0] && (
                    <text
                      x={leftGutter - 8}
                      y={y + 4}
                      textAnchor="end"
                      fontSize={11}
                      fill={shade(shownMetrics[0].color)}
                    >
                      {formatValue(
                        shownMetrics[0].key,
                        shownMetrics[0].max * (1 - ratio),
                      )}
                    </text>
                  )}
                  {!isCompact && shownMetrics[1] && (
                    <text
                      x={leftGutter + plotWidth + 8}
                      y={y + 4}
                      textAnchor="start"
                      fontSize={11}
                      fill={shade(shownMetrics[1].color)}
                    >
                      {formatValue(
                        shownMetrics[1].key,
                        shownMetrics[1].max * (1 - ratio),
                      )}
                    </text>
                  )}
                </g>
              );
            })}

            {xTicks.map((index) => (
              <text
                key={index}
                x={x(index)}
                y={CHART_HEIGHT - 8}
                textAnchor={
                  index === 0
                    ? "start"
                    : index === points.length - 1
                      ? "end"
                      : "middle"
                }
                fontSize={11}
                fill={axisTextColor}
              >
                {dayjs(points[index].day).format("D MMM")}
              </text>
            ))}

            {hoveredIndex !== null && (
              <line
                x1={x(hoveredIndex)}
                x2={x(hoveredIndex)}
                y1={12}
                y2={12 + plotHeight}
                stroke={axisTextColor}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            )}

            {shownMetrics.map((metric) => {
              const y = (value: number) => scaleY(value, metric.max);
              const segments = buildPathSegments(metric.values, x, y);
              const color = shade(metric.color);

              return (
                <g key={metric.key}>
                  {shownMetrics.length === 1 &&
                    segments.map((segment, index) => {
                      const area = closeAreaPath(segment, 12 + plotHeight);
                      return area ? (
                        <path
                          key={`area-${index}`}
                          d={area}
                          fill={color}
                          opacity={0.12}
                        />
                      ) : null;
                    })}

                  {segments.map((segment, index) => (
                    <path
                      key={`line-${index}`}
                      d={segment.d}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      // A rebuilt stretch is dashed so it cannot be mistaken
                      // for a total captured on that day.
                      strokeDasharray={segment.estimated ? "4 4" : undefined}
                    />
                  ))}

                  {isolatedPointIndexes(metric.values).map((index) => (
                    <circle
                      key={`dot-${index}`}
                      cx={x(index)}
                      cy={y(metric.values[index].value as number)}
                      r={2.5}
                      fill={color}
                    />
                  ))}

                  {hoveredIndex !== null &&
                    metric.values[hoveredIndex]?.value != null && (
                      <circle
                        cx={x(hoveredIndex)}
                        cy={y(metric.values[hoveredIndex].value as number)}
                        r={4}
                        fill={color}
                        stroke={
                          colorScheme === "dark"
                            ? theme.colors.dark[7]
                            : theme.white
                        }
                        strokeWidth={2}
                      />
                    )}
                </g>
              );
            })}
          </svg>
        )}

        {hoveredPoint && (
          <Paper
            withBorder
            shadow="md"
            p="xs"
            style={{
              position: "absolute",
              top: 0,
              left: Math.min(
                Math.max(x(hoveredIndex as number) - 80, 0),
                Math.max(chartWidth - 176, 0),
              ),
              width: 176,
              pointerEvents: "none",
            }}
          >
            <Text size="xs" fw={600} mb={4}>
              {dayjs(hoveredPoint.day).format("LL")}
            </Text>
            <Stack gap={2}>
              {shownMetrics.map((metric) => {
                const value = metric.values[hoveredIndex as number].value;
                return (
                  <Group key={metric.key} justify="space-between" gap="xs">
                    <Group gap={6}>
                      <Box
                        w={8}
                        h={8}
                        style={{
                          borderRadius: "50%",
                          backgroundColor: shade(metric.color),
                        }}
                      />
                      <Text size="xs" c="dimmed">
                        <FormattedMessage id={metric.labelId} />
                      </Text>
                    </Group>
                    <Text size="xs" fw={600}>
                      {value === null
                        ? t("admin.stats.tooltip.no-data")
                        : formatValue(metric.key, value)}
                    </Text>
                  </Group>
                );
              })}
            </Stack>
          </Paper>
        )}
      </Box>

      {!isLoading && !hasFailed && (
        <Text size="xs" c="dimmed" mt="sm">
          {series?.snapshotsFrom ? (
            <FormattedMessage
              id="admin.stats.history.partial"
              values={{ date: dayjs(series.snapshotsFrom).format("LL") }}
            />
          ) : (
            <FormattedMessage id="admin.stats.history.empty" />
          )}
        </Text>
      )}
    </Paper>
  );
};

export default UsageChart;
