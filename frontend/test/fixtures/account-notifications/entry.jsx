import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { COLOR_PALETTES } from "../../../src/styles/mantine.style";
import { IntlProvider } from "react-intl";
import AccountNotificationSettings from "../../../src/components/account/AccountNotificationSettings";
import { UserContext } from "../../../src/hooks/user.hook";
import fr from "../../../src/i18n/translations/fr-FR";

async function main() {
  const response = await fetch("/fixture.json");
  if (!response.ok) throw new Error("Fixture request failed");
  const fixture = await response.json();
  let subscription = fixture.subscribed ? makeSubscription() : null;
  function makeSubscription() {
    return {
      toJSON: () => ({
        endpoint: "https://push.example.test/fixture",
        keys: { p256dh: "fixture", auth: "fixture" },
      }),
      unsubscribe: async () => {
        subscription = null;
        return true;
      },
    };
  }
  Object.defineProperty(window, "PushManager", {
    configurable: true,
    value: class {},
  });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: {
      get permission() {
        return fixture.permission;
      },
      requestPermission: async () => fixture.permission,
    },
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async () => (subscription = makeSubscription()),
        },
      }),
    },
  });
  function App() {
    const [user, setUser] = useState(fixture.user);
    const refreshUser = async () => {
      const updated = await fetch("/api/users/me").then((r) => r.json());
      setUser(updated);
      return updated;
    };
    return (
      <IntlProvider locale="fr" messages={fr}>
        <MantineProvider
          deduplicateCssVariables={false}
          forceColorScheme="dark"
          theme={{ ...COLOR_PALETTES.amber, fontFamily: "Arial, sans-serif" }}
        >
          <UserContext.Provider value={{ user, refreshUser }}>
            <main style={{ maxWidth: 960, margin: "24px auto", padding: 16 }}>
              <AccountNotificationSettings />
            </main>
          </UserContext.Provider>
        </MantineProvider>
      </IntlProvider>
    );
  }
  createRoot(document.getElementById("root")).render(<App />);
}
main().catch((error) => {
  console.error(error);
  throw error;
});
