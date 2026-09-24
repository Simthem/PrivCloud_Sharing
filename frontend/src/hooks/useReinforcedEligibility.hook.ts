import { useEffect, useState } from "react";
import signingService from "../services/signing.service";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Addresses that cannot sign at the reinforced level, checked while the
 * request is being written so the requester is warned before sending.
 */
const useReinforcedEligibility = (
  signatureLevel: string,
  recipients: { email: string; role?: string }[],
) => {
  const [ineligible, setIneligible] = useState<Set<string>>(new Set());
  const key =
    signatureLevel === "REINFORCED"
      ? [
          ...new Set(
            recipients
              .filter((recipient) => (recipient.role || "SIGNER") !== "CC")
              .map((recipient) => recipient.email.trim().toLowerCase())
              .filter((email) => EMAIL.test(email)),
          ),
        ]
          .sort()
          .join("\n")
      : "";

  useEffect(() => {
    if (!key) {
      setIneligible(new Set());
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      signingService
        .checkReinforcedEligibility(key.split("\n"))
        .then((result) => {
          if (!active) return;
          setIneligible(
            new Set(
              result.recipients
                .filter((recipient) => !recipient.eligible)
                .map((recipient) => recipient.email.toLowerCase()),
            ),
          );
        })
        .catch(() => {
          // The server still refuses an ineligible request on submit.
          if (active) setIneligible(new Set());
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key]);

  return ineligible;
};

export default useReinforcedEligibility;
