import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDisclosure } from "@mantine/hooks";
import useUser from "../../hooks/user.hook";
import teamService from "../../services/team.service";
import CreateTeamModal from "./CreateTeamModal";

/**
 * Checks if the logged-in user has been designated as a team admin
 * but doesn't own a team yet. If so, shows a mandatory modal to
 * create their team. This runs once per session (uses sessionStorage
 * to avoid nagging on every page navigation).
 */
const TeamStatusChecker = () => {
  const { user } = useUser();
  const [modalOpened, { open, close }] = useDisclosure(false);
  const [_dismissed, setDismissed] = useState(false);

  const { data: status } = useQuery({
    queryKey: ["teams.status"],
    queryFn: () => teamService.getTeamStatus(),
    enabled: !!user && !user.isAdmin, // Don't check for SaaS admins
    staleTime: 120_000,
  });

  useEffect(() => {
    if (!status?.needsTeamCreation) return;

    // Only show once per session (user can dismiss and do it later via settings)
    const key = `team_create_modal_shown_${user?.id}`;
    if (sessionStorage.getItem(key)) {
      return;
    }

    sessionStorage.setItem(key, "1");
    open();
  }, [status, user]);

  const handleClose = () => {
    setDismissed(true);
    close();
  };

  if (!status?.needsTeamCreation) {
    return null;
  }

  return (
    <CreateTeamModal
      opened={modalOpened}
      onClose={handleClose}
      mandatory={false}
    />
  );
};

export default TeamStatusChecker;
