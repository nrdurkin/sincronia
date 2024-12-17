import { Sinc } from "@sincronia/types";
import ProgressBar from "progress";

export const allSettled = <T>(
  promises: Promise<T>[]
): Promise<Sinc.PromiseResult<T>[]> => {
  return Promise.all(
    promises.map((prom) =>
      prom
        .then(
          (value): Sinc.PromiseResult<T> => ({
            status: "fulfilled",
            value,
          })
        )
        .catch(
          (reason: Error): Sinc.PromiseResult<T> => ({
            status: "rejected",
            reason,
          })
        )
    )
  );
};

export const aggregateErrorMessages = (
  errs: Error[],
  defaultMsg: string,
  labelFn: (err: Error, index: number) => string
): string => {
  return errs.reduce((acc, err, index) => {
    return `${acc}\n${labelFn(err, index)}:\n${err.message || defaultMsg}`;
  }, "");
};

export const summarizeRecord = (table: string, recDescriptor: string): string =>
  `${table} > ${recDescriptor}`;

export const getProgTick = (logLevel: string, total: number): (() => void) => {
  if (logLevel === "info") {
    const progBar = new ProgressBar(":bar (:percent)", {
      total,
      width: 60,
    });
    return () => {
      progBar.tick();
    };
  }
  // no-op at other log levels
  return () => undefined;
};
