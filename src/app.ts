import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { RequestListener } from "node:http";
import express, {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import "express-async-errors";
import pino from "pino";
import helmet from "helmet";
import compression from "compression";
import { getClientIp } from "request-ip";
import * as ev from "express-validator";
import { Config } from "./config";
const axios = require("axios");

export type App = {
  requestListener: RequestListener;
  shutdown: () => Promise<void>;
};

declare global {
  namespace Express {
    interface Request {
      abortSignal: AbortSignal;
    }
  }
}

const LARGE_JSON_PATH = "/large-json-payload";
const APPLICATION_JSON = "application/json";

export const initApp = async (
  config: Config,
  logger: pino.Logger
): Promise<App> => {
  const app = express();
  app.set("trust proxy", true);
  app.use(
    express.raw({
      limit: "1kb",
      type: (req) => req.headers["content-type"] !== APPLICATION_JSON,
    })
  );
  app.use(
    express.json({
      limit: "50kb",
      type: (req) => {
        return (
          req.headers["content-type"] === APPLICATION_JSON &&
          req.url !== LARGE_JSON_PATH
        );
      },
    })
  );
  app.use((req, res, next) => {
    const start = new Date().getTime();
    const ac = new AbortController();
    req.abortSignal = ac.signal;
    res.on("close", ac.abort.bind(ac));

    const requestId = req.headers["x-request-id"]?.[0] || randomUUID();

    const l = logger.child({ requestId });

    let bytesRead = 0;
    req.on("data", (chunk: Buffer) => {
      bytesRead += chunk.length;
    });

    let bytesWritten = 0;
    const oldWrite = res.write;
    const oldEnd = res.end;
    res.write = function (chunk: Buffer | string, ...rest) {
      if (chunk) bytesWritten += chunk.length;

      // @ts-ignore
      return oldWrite.apply(res, [chunk, ...rest]);
    };
    // @ts-ignore
    res.end = function (chunk?: Buffer | string, ...rest) {
      if (chunk) bytesWritten += chunk.length;

      // @ts-ignore
      return oldEnd.apply(res, [chunk, ...rest]);
    };

    res.on("finish", () => {
      l.info(
        {
          duration: new Date().getTime() - start,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ua: req.headers["user-agent"],
          ip: getClientIp(req),
          br: bytesRead,
          bw: bytesWritten,
        },
        "Request handled"
      );
    });

    asl.run({ logger: l, requestId }, () => next());
  });
  app.use(helmet());
  app.use(compression());

  app.get(config.healthCheckEndpoint, (req, res) => {
    res.sendStatus(200);
  });

  app.get("/hi", (req, res) => {
    const s = asl.getStore();
    s?.logger.info("hi");
    res.send("hi");
  });

  app.get("/workouts", async (req, res) => {
    try {
      const data = JSON.stringify({
        collection: "sets",
        database: "workouts",
        dataSource: "Cluster0",
      });

      const config = {
        method: "post",
        url: "https://ap-southeast-1.aws.data.mongodb-api.com/app/data-tegrm/endpoint/data/v1/action/find",
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Request-Headers": "*",
          "api-key":
            "3jTx1QNw0d0Lgn0HZ3sN10vdf26mdYraV8HCsblSMAMe0JbY6WEqODvlPZ3P9Feg",
        },
        data,
      };

      const response = await axios(config);

      res.json(response.data); // Send the parsed JSON response directly
    } catch (error) {
      console.error(error);
      res.status(500).send("Error fetching data"); // Handle errors gracefully
    }
  });

  app.post(
    "/echo",
    makeValidationMiddleware([ev.body("name").notEmpty()]),
    (req, res) => {
      res.json({ msg: `hi ${req.body.name}` });
    }
  );

  app.post(
    LARGE_JSON_PATH,
    express.json({ limit: "5mb", type: APPLICATION_JSON }),
    (req, res) => {
      // TODO: handle large json payload
      res.end();
    }
  );

  app.get("/abort-signal-propagation", async (req, res) => {
    for (let i = 0; i < 10; i++) {
      // simulate some work
      await new Promise((r) => setTimeout(r, 25));

      if (req.abortSignal.aborted) throw new Error("aborted");
    }

    const usersRes = await fetch("https://jsonplaceholder.typicode.com/users", {
      signal: req.abortSignal,
    });
    if (usersRes.status !== 200) {
      throw new Error(`unexpected non-200 status code ${usersRes.status}`);
    }
    const users = await usersRes.json();
    res.json(users);
  });

  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    asl.getStore()?.logger.error(err);

    if (res.headersSent) return;

    res.status(500);
    res.json({ msg: "Something went wrong" });
  });

  return {
    requestListener: app,
    shutdown: async () => {
      // add any cleanup code here including database/redis disconnecting and background job shutdown
    },
  };
};

type Store = {
  logger: pino.Logger;
  requestId: string;
};

export function makeValidationMiddleware(
  runners: ev.ContextRunner[]
): RequestHandler {
  return async function (req: Request, res: Response, next: NextFunction) {
    await Promise.all(runners.map((runner) => runner.run(req)));

    const errors = ev.validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        errors: errors.array(),
      });
      return;
    }

    next();
  };
}
