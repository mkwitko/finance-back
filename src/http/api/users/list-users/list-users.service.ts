import type { UsersRepository } from "../users.repository.js";
import type { User } from "../users.types.js";

export type ListUsersDeps = {
  usersRepo: UsersRepository;
};

export function createListUsersService(deps: ListUsersDeps) {
  return async (input: { limit: number }): Promise<User[]> => {
    return deps.usersRepo.listUsers({ limit: input.limit });
  };
}
