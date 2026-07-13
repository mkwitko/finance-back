import type { DeepseekGateway } from "../gateways/deepseek/deepseek.gateway.js";
import type { GoogleGateway } from "../gateways/google/google.gateway.js";

// External dependencies exposed via the `app.gateways` decorator so they can be
// faked in tests. Google verifies Sign-In ID tokens; Deepseek powers AI
// categorization / planning (custom JWT + Google Sign-In auth — no Cognito/Amplify).
export type Gateways = {
  google: GoogleGateway;
  deepseek: DeepseekGateway;
};
