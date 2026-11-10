import { Button } from "@mantine/core";
import { FaMicrosoft } from "react-icons/fa";
import { SiDiscord, SiGithub, SiGoogle, SiOpenid } from "react-icons/si";

import { markOAuthSignIn } from "../../utils/authRedirect.util";

const getOAuthUrl = (appUrl: string, provider: string) => {
  return `${appUrl}/api/oauth/auth/${provider}`;
};

const getOAuthIcon = (provider: string) => {
  return {
    google: <SiGoogle />,
    microsoft: <FaMicrosoft />,
    github: <SiGithub />,
    discord: <SiDiscord />,
    oidc: <SiOpenid />,
  }[provider];
};

const getOAuthColor = (provider: string): string => {
  return (
    {
      google: "red",
      microsoft: "blue",
      github: "gray",
      discord: "violet",
      oidc: "teal",
    }[provider] ?? "gray"
  );
};

type OAuthProviderButtonProps = {
  label: string;
  provider: string;
};

const OAuthProviderButton = ({ label, provider }: OAuthProviderButtonProps) => (
  <Button
    component="a"
    title={label}
    href={getOAuthUrl(window.location.origin, provider)}
    onClick={markOAuthSignIn}
    variant="outline"
    color={getOAuthColor(provider)}
    fullWidth
  >
    {getOAuthIcon(provider)}
    {"\u2002" + label}
  </Button>
);

export default OAuthProviderButton;
