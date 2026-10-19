import { useQuery, useQueryClient } from "@tanstack/react-query";
import teamService from "../services/team.service";
import {
  getUserKey,
  importKeyFromBase64,
  unwrapReverseShareKey,
} from "./crypto.util";
import {
  encryptTeamProfile,
  openTeamProfile,
  type TeamProfile,
} from "./fileMetadata.util";

/**
 * The current K_team, or null. No fallback key: company details encrypted
 * with anything else would be unreadable by the other administrators.
 */
export async function resolveCurrentTeamKey(teamId: string) {
  const userKeyB64 = getUserKey();
  if (!userKeyB64) return null;
  const { wrappedTeamKey, keyVersion, memberKeyVersion } =
    await teamService.getTeamKey(teamId);
  if (!wrappedTeamKey || memberKeyVersion !== keyVersion) return null;
  const masterKey = await importKeyFromBase64(userKeyB64);
  return {
    key: await unwrapReverseShareKey(wrappedTeamKey, masterKey),
    keyVersion,
  };
}

export type TeamProfileState = {
  profile?: TeamProfile;
  // False when this browser cannot read or write the details.
  keyAvailable: boolean;
};

/** Company details of a team, for its administrators only. */
export function useTeamProfile(teamId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["team-profile", teamId],
    enabled: enabled && !!teamId,
    retry: false,
    queryFn: async (): Promise<TeamProfileState> => {
      const current = await resolveCurrentTeamKey(teamId).catch(() => null);
      if (!current) return { keyAvailable: false };
      const stored = await teamService.getTeamProfile(teamId);
      return {
        keyAvailable: true,
        profile: await openTeamProfile(
          current.key,
          teamId,
          stored?.encryptedInfo,
        ),
      };
    },
  });
}

/** Encrypts in the browser, the server only stores the ciphertext. */
export function useSaveTeamProfile(teamId: string) {
  const queryClient = useQueryClient();
  return async (profile: TeamProfile | null) => {
    const current = await resolveCurrentTeamKey(teamId);
    if (!current) throw new Error("The current team key is unavailable");
    await teamService.setTeamProfile(
      teamId,
      profile ? await encryptTeamProfile(current.key, teamId, profile) : null,
      current.keyVersion,
    );
    await queryClient.invalidateQueries({ queryKey: ["team-profile", teamId] });
  };
}
