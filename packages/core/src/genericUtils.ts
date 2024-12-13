import { Sinc } from "@sincronia/types";

export function wait(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  });
}

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
