/** Fields the app reads on a caught value: axios, upload worker and browser errors. */
export type ThrownError = {
  name?: string;
  message?: string;
  code?: string;
  status?: number;
  cancelled?: boolean;
  quota?: boolean;
  sizeLimit?: boolean;
  chunk?: unknown;
  data?: ErrorBody;
  response?: { status?: number; data?: ErrorBody };
};

type ErrorBody = { message?: string; error?: string; [field: string]: unknown };
