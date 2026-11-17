import { GetServerSidePropsContext } from "next";
import { languageParameter } from "../../utils/authRedirect.util";

// Redirect to the share page
export function getServerSideProps(context: GetServerSidePropsContext) {
  const { shareId } = context.params!;
  const language = languageParameter(context.query.lang);

  return {
    props: {},
    redirect: {
      permanent: false,
      destination: "/share/" + shareId + (language ? `?lang=${language}` : ""),
    },
  };
}

export default function ShareAlias() {
  return null;
}
