import "@mantine/core/styles/Switch.css";
import {
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { AdminConfig, UpdateConfig } from "../../../types/config.type";
import { COLOR_PALETTES } from "../../../styles/mantine.style";
import {
  ALTCHA_ALGORITHM_SELECT_OPTIONS,
  ALTCHA_AUTO_SELECT_OPTIONS,
  ALTCHA_CODE_CHALLENGE_DISPLAY_SELECT_OPTIONS,
  ALTCHA_DISPLAY_SELECT_OPTIONS,
  ALTCHA_TYPE_SELECT_OPTIONS,
} from "../../../utils/altcha.util";
import { stringToTimespan, timespanToString } from "../../../utils/date.util";
import FileSizeInput from "../../core/FileSizeInput";
import TimespanInput from "../../core/TimespanInput";

const PALETTE_OPTIONS = Object.keys(COLOR_PALETTES).map((name) => ({
  value: name,
  label: name.charAt(0).toUpperCase() + name.slice(1),
}));

const CONFIG_SELECT_OPTIONS: Record<
  string,
  { value: string; label: string }[]
> = {
  "altcha.algorithm": ALTCHA_ALGORITHM_SELECT_OPTIONS,
  "altcha.auto": ALTCHA_AUTO_SELECT_OPTIONS,
  "altcha.codeChallengeDisplay": ALTCHA_CODE_CHALLENGE_DISPLAY_SELECT_OPTIONS,
  "altcha.display": ALTCHA_DISPLAY_SELECT_OPTIONS,
  "altcha.language": [
    { value: "fr-fr", label: "fr-fr" },
    { value: "en", label: "en" },
  ],
  "altcha.theme": [
    { value: "lime", label: "lime" },
    { value: "default", label: "default" },
    { value: "aqua", label: "aqua" },
    { value: "business", label: "business" },
    { value: "caramel", label: "caramel" },
    { value: "cupcake", label: "cupcake" },
    { value: "cyberpunk", label: "cyberpunk" },
    { value: "wireframe", label: "wireframe" },
  ],
  "altcha.type": ALTCHA_TYPE_SELECT_OPTIONS,
};

const AdminConfigInput = ({
  configVariable,
  updateConfigVariable,
}: {
  configVariable: AdminConfig;
  updateConfigVariable: (_variable: UpdateConfig) => void;
}) => {
  const form = useForm({
    initialValues: {
      stringValue: configVariable.value ?? configVariable.defaultValue,
      textValue: configVariable.value ?? configVariable.defaultValue,
      numberValue: parseInt(
        configVariable.value ?? configVariable.defaultValue,
      ),
      booleanValue:
        (configVariable.value ?? configVariable.defaultValue) == "true",
    },
  });

  const onValueChange = (configVariable: AdminConfig, value: any) => {
    form.setFieldValue(`${configVariable.type}Value`, value);
    updateConfigVariable({ key: configVariable.key, value: value });
  };

  const selectOptions = CONFIG_SELECT_OPTIONS[configVariable.key];
  const selectValue =
    selectOptions?.some((option) => option.value === form.values.stringValue)
      ? form.values.stringValue
      : configVariable.defaultValue;

  return (
    <Stack align="end">
      {configVariable.type == "string" &&
      configVariable.key === "general.colorPalette" ? (
        <Select
          style={{ width: "100%" }}
          disabled={!configVariable.allowEdit}
          data={PALETTE_OPTIONS}
          value={form.values.stringValue}
          onChange={(value) => {
            if (value) onValueChange(configVariable, value);
          }}
        />
      ) : configVariable.type == "string" &&
        selectOptions ? (
        <Select
          style={{ width: "100%" }}
          disabled={!configVariable.allowEdit}
          data={selectOptions}
          value={selectValue}
          onChange={(value) => {
            if (value) onValueChange(configVariable, value);
          }}
        />
      ) : (
        configVariable.type == "string" &&
        (configVariable.obscured ? (
          <PasswordInput
            autoComplete="new-password"
            style={{
              width: "100%",
            }}
            disabled={!configVariable.allowEdit}
            {...form.getInputProps("stringValue")}
            onChange={(e) => onValueChange(configVariable, e.target.value)}
          />
        ) : (
          <TextInput
            style={{
              width: "100%",
            }}
            disabled={!configVariable.allowEdit}
            {...form.getInputProps("stringValue")}
            placeholder={configVariable.defaultValue}
            onChange={(e) => onValueChange(configVariable, e.target.value)}
          />
        ))
      )}

      {configVariable.type == "text" && (
        <Textarea
          style={{
            width: "100%",
          }}
          disabled={!configVariable.allowEdit}
          autosize
          {...form.getInputProps("textValue")}
          placeholder={configVariable.defaultValue}
          onChange={(e) => onValueChange(configVariable, e.target.value)}
        />
      )}
      {configVariable.type == "number" && (
        <NumberInput
          {...form.getInputProps("numberValue")}
          disabled={!configVariable.allowEdit}
          placeholder={configVariable.defaultValue}
          onChange={(number) => onValueChange(configVariable, number)}
          w={201}
        />
      )}
      {configVariable.type == "filesize" && (
        <FileSizeInput
          {...form.getInputProps("numberValue")}
          disabled={!configVariable.allowEdit}
          value={parseInt(configVariable.value ?? configVariable.defaultValue)}
          onChange={(bytes) => onValueChange(configVariable, bytes)}
          w={201}
        />
      )}
      {configVariable.type == "boolean" && (
        <>
          <Switch
            disabled={!configVariable.allowEdit}
            {...form.getInputProps("booleanValue", { type: "checkbox" })}
            onChange={(e) => onValueChange(configVariable, e.target.checked)}
          />
        </>
      )}
      {configVariable.type == "timespan" && (
        <TimespanInput
          value={stringToTimespan(configVariable.value)}
          disabled={!configVariable.allowEdit}
          onChange={(timespan) =>
            onValueChange(configVariable, timespanToString(timespan))
          }
          w={201}
        />
      )}
    </Stack>
  );
};

export default AdminConfigInput;
