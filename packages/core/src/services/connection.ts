import { Sinc } from "@sincronia/types";
import axios from "axios";
import rateLimit, { RateLimitedAxiosInstance } from "axios-rate-limit";

export const baseUrlGQL = () =>
  `https://${process.env.SN_INSTANCE}/api/now/graphql`;

export const connection = (
  creds?: Sinc.LoginAnswers
): RateLimitedAxiosInstance => {
  const username = creds?.username || process.env.SN_USER || "";
  const password = creds?.password || process.env.SN_PASSWORD || "";
  const instance = creds?.instance || process.env.SN_INSTANCE || "";

  return rateLimit(
    axios.create({
      withCredentials: true,
      auth: {
        username,
        password,
      },
      headers: {
        "Content-Type": "application/json",
      },
      baseURL: `https://${instance}/`,
    }),
    { maxRPS: 20 }
  );
};
