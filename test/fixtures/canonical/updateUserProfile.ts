import { flow } from 'fp-ts/function';
import { Lens } from 'monocle-ts';
import { Newtype, iso } from 'newtype-ts';

export type Email = Newtype<{ readonly Email: unique symbol }, string>;

export type UserProfile = {
  readonly id: string;
  readonly contact: {
    readonly email: Email;
    readonly city: string;
  };
};

export type NormalizeUserProfile = (profile: UserProfile) => UserProfile;

const isoEmail = iso<Email>();
const emailLens = Lens.fromPath<UserProfile>()(['contact', 'email']);
const cityLens = Lens.fromPath<UserProfile>()(['contact', 'city']);

const trimAndLower = (s: string) => s.trim().toLowerCase();
const trimOnly = (s: string) => s.trim();

const normalizeEmail = isoEmail.modify(trimAndLower);
const updateEmail = emailLens.modify(normalizeEmail);
const updateCity = cityLens.modify(trimOnly);

export const normalizeUserProfile = flow(
  updateEmail,
  updateCity,
) satisfies NormalizeUserProfile;
