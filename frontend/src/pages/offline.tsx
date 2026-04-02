import { Center, Stack, Text, Title } from "@mantine/core";
import Meta from "../components/Meta";

const Offline = () => {
  return (
    <>
      <Meta title="Offline" />
      <Center style={{ height: "70vh" }}>
        <Stack align="center" spacing="md">
          <Title order={2}>You are offline</Title>
          <Text color="dimmed" align="center" maw={400}>
            PrivCloud_Sharing requires an internet connection to upload and
            download files. Please check your connection and try again.
          </Text>
        </Stack>
      </Center>
    </>
  );
};

export default Offline;
