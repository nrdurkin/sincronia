import { Sinc } from "@sincronia/types";
import axios from "axios";
import rateLimit, { RateLimitedAxiosInstance } from "axios-rate-limit";

const {
  SN_USER: username = "",
  SN_PASSWORD: password = "",
  SN_INSTANCE: instance = "",
} = process.env;

export const baseUrlGQL = `https://${instance}/api/now/graphql`;

export const connection = rateLimit(
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

export const authConnection = ({
  instance,
  username,
  password,
}: Sinc.LoginAnswers): RateLimitedAxiosInstance => {
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
