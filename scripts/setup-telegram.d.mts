export const EXPECTED_BOT: string;
export const EXPECTED_GROUP: string;
export function matchingGroups(updates: any[]): { id: string; title: string }[];
export function requireUniqueGroup<T>(candidates: T[]): T;
export function verifyBotIdentity(bot: any): void;
