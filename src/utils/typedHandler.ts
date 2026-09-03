/* eslint-disable @typescript-eslint/no-explicit-any */
import { RequestHandler } from "express";

export const typedHandler = <T extends (...args: any[]) => any>(fn: T): RequestHandler => {
  return fn as any as RequestHandler;
};

export const getParams = <T>(req: any): T => req.params as T;
export const getBody = <T>(req: any): T => req.body as T;
export const getQuery = <T>(req: any): T => req.query as T;
