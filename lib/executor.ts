import { NextApiHandler, NextApiRequest, NextApiResponse } from "next";
import { Middleware } from ".";
import { controlledPromise, isPromise } from "./promises";

// This gets invoked internally by `use` and `label`
export function makeMiddlewareExecutor(middlewareFns: Middleware[]) {
  // This curried function receives an API route
  return function curryApiHandler(apiRouteFn: NextApiHandler): NextApiHandler {
    // The final function returned is a Next API handler that
    // is responsible for executing all the middleware provided,
    // as well as the API route handler
    return async function finalRouteHandler(req, res) {
      await new Executor(middlewareFns, apiRouteFn, req, res).run();
    };
  };
}

export class Executor {
  /**
   * The first middleware function in the queue
   */
  currentFn: Middleware;

  /**
   * Middleware remaining in the queue
   */
  remaining: Middleware[];

  /**
   * The return value of `currentFn`
   */
  result?: void | Promise<void>;

  /**
   * A controlled promise that is used to manage
   * the success or failure of this Executor
   */
  internalPromise = controlledPromise();
  succeed = this.internalPromise.resolve;
  fail = this.internalPromise.reject;

  /**
   * A controlled promise that is used to
   * "pause" async middleware from completing until
   * the rest of the `remaining` queue is executed
   */
  teardownPromise = controlledPromise();

  constructor(
    [currentFn, ...remaining]: Middleware[],
    public apiRouteFn: NextApiHandler,
    public req: NextApiRequest,
    public res: NextApiResponse
  ) {
    this.currentFn = currentFn;
    this.remaining = remaining;
  }

  /**
   * Execute the current middleware function.
   *
   * If it fails, the remaining middleware and API route
   * handler are not executed and the error is thrown up.
   *
   * If it succeeds, an executor is created to handle
   * the remaining middleware.
   */
  run(): Promise<void> {
    try {
      // Call the current function
      this.result = this.currentFn(this.req, this.res, (error?: any) => {
        // Look for errors from synchronous middleware
        if (error) {
          // Throw errors to be caught in the try/catch block
          throw error;
        }

        // Return teardown promise to "pause" async middleware
        return this.teardownPromise.promise;
      });

      let asyncMiddlewareFailed = false;

      // Add handlers to async middleware, if available
      if (isPromise(this.result)) {
        this.result.then(
          () => {
            this.succeed();
          },
          (err) => {
            asyncMiddlewareFailed = true;
            this.fail(err);
          }
        );
      }

      // Use a microtask to give async middleware a chance to fail
      queueMicrotask(() => {
        if (!asyncMiddlewareFailed) {
          // Things look good so far – execute the rest of the queue
          this.runRemaining();
        }
      });
    } catch (err) {
      // Catches errors from synchronous middleware
      this.fail(err);
    }

    return this.internalPromise.promise;
  }

  /**
   * Execute the remaining middleware, then resume the result
   * promise if it is available.
   */
  async runRemaining(): Promise<void> {
    try {
      if (this.remaining.length === 0) {
        // No more middleware, execute the API route handler
        await this.apiRouteFn(this.req, this.res);
      } else {
        // Recursively execute remaining middleware
        const remainingExecutor = new Executor(
          this.remaining,
          this.apiRouteFn,
          this.req,
          this.res
        );

        await remainingExecutor.run();
      }

      // The remaining queue is now empty
      this.finish();
    } catch (err) {
      this.finish(err);
    }
  }

  /**
   * Ensure this executor finishes by handling errors
   * correctly, resuming async middleware (if the current
   * middleware is async), or resolving the internal
   * promise as a success.
   */
  finish(error?: any) {
    if (isPromise(this.result)) {
      // Current middleware is async
      if (error) {
        // Let the result have a chance to handle the error
        this.teardownPromise.reject(error);
      } else {
        // Let the result continue its teardown
        this.teardownPromise.resolve();
      }
    } else {
      // Current middleware is synchronous
      if (error) {
        // Synchronous middleware cannot handle errors,
        // trigger a failure
        this.fail(error);
      } else {
        // Synchronous middleware has no teardown phase,
        // trigger a success
        this.succeed();
      }
    }
  }
}
