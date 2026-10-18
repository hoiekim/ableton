import { SessionConfig } from "../config";
import { createJevProvider } from "./jev";
import { localProvider } from "./local";
import { DecisionProvider } from "./types";

export * from "./types";
export { decideLocally, localProvider } from "./local";

export const createProvider = (config: SessionConfig): DecisionProvider => {
  const useJev = config.provider === "jev" || (config.provider === "auto" && !!process.env.TYPESAFE_API_KEY);
  return useJev ? createJevProvider(config.jev) : localProvider;
};
