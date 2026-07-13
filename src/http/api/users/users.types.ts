// Domain user. `id` is the internal bigint PK — never serialized by the API
// (presenters expose `uuid` as `id`). Dates are ISO strings above the repository.
export type User = {
  id: number;
  uuid: string;
  email: string;
  name: string;
  picture: string | null;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UpsertGoogleUserInput = {
  googleSub: string;
  email: string;
  name: string;
  picture: string | null;
  emailVerified: boolean;
};
