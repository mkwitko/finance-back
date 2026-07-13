import { ERRORS } from "../../../../shared/errors/catalog.js";
import type { UsersRepository } from "../../users/users.repository.js";
import type { User } from "../../users/users.types.js";

export type GetMeDeps = {
  usersRepo: UsersRepository;
};

export function createGetMeService(deps: GetMeDeps) {
  return async (input: { userUuid: string }): Promise<User> => {
    const user = await deps.usersRepo.findByUuid(input.userUuid);
    if (!user) throw ERRORS.AUTH.USER_NOT_FOUND();
    return user;
  };
}
