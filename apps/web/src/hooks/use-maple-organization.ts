import { useOrganization } from "@clerk/clerk-react";
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode";

export function useMapleOrganizationId() {
  if (!isClerkAuthEnabled) return 'default';

  const { organization } = useOrganization();

  if (!organization) return null;

  return organization.id;
}