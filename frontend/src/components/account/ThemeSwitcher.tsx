import {
  Box,
  Center,
  SegmentedControl,
  Stack,
} from "@mantine/core";
import { useState } from "react";
import { TbDeviceLaptop, TbMoon, TbSun } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import userPreferences from "../../utils/userPreferences.util";

const ThemeSwitcher = () => {
  const [colorScheme, setColorScheme] = useState(
    userPreferences.get("colorScheme"),
  );
  return (
    <Stack>
      <SegmentedControl
        value={colorScheme}
        onChange={(value) => {
          userPreferences.set("colorScheme", value);
          setColorScheme(value);
          window.dispatchEvent(new Event("theme-change"));
        }}
        data={[
          {
            label: (
              <Center>
                <TbMoon size={16} />
                <Box ml={10}>
                  <FormattedMessage id="account.theme.dark" />
                </Box>
              </Center>
            ),
            value: "dark",
          },
          {
            label: (
              <Center>
                <TbSun size={16} />
                <Box ml={10}>
                  <FormattedMessage id="account.theme.light" />
                </Box>
              </Center>
            ),
            value: "light",
          },
          {
            label: (
              <Center>
                <TbDeviceLaptop size={16} />
                <Box ml={10}>
                  <FormattedMessage id="account.theme.system" />
                </Box>
              </Center>
            ),
            value: "system",
          },
        ]}
      />
    </Stack>
  );
};

export default ThemeSwitcher;
