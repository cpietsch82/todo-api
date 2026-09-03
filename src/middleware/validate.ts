import type { Request, Response, NextFunction } from "express";
import { ZodObject, ZodError } from "zod";
import { ParamsDictionary } from "express-serve-static-core";
import { ParsedQs } from "qs";

/**
 * Validates a custom schema
 * @param schema Schema to validate
 * @returns (Promise<void>)
 * @throws {Error} if validation failed
 */
export const validate = (schema: ZodObject) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    // await schema.parseAsync({
    //   body: req.body,
    //   query: req.query,
    //   params: req.params,
    // });

    const validated = await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    // const body = schema.parse(req.body);

    // Überschreibe req mit validierten & transformierten Daten
    req.body = validated.body ?? req.body;
    req.query = (validated.query ?? req.query) as ParsedQs;
    req.params = (validated.params ?? req.params) as ParamsDictionary;

    next();
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        status: "error",
        message: "Validation error",
        errors: error.issues.map((err) => ({
          path: err.path.join("."),
          message: err.message,
        })),
      });
    }
    next(error);
  }
};

export const validateBody = (schema: ZodObject) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedData = schema.parse(req.body);
      req.body = validatedData;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          status: "error",
          message: "Body validation error",
          errors: error.issues.map((err) => ({
            path: err.path.join("."),
            message: err.message,
          })),
        });
      }
      next(error);
    }
  };
};

export const validateParams = (schema: ZodObject) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.params);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Invalid parameters",
          errors: error.issues.map((err) => ({
            path: err.path.join("."),
            message: err.message,
          })),
        });
      }
      next(error);
    }
  };
};

// export const validateQuery = (schema: ZodObject) => {
//   return (req: Request, res: Response, next: NextFunction) => {
//     try {
//       const result = schema.parse(req.query);
//       req.query = result.data;
//       next();
//     } catch (error) {
//       if (error instanceof ZodError) {
//         return res.status(400).json({
//           error: "Invalid parameters",
//           errors: error.issues.map((err) => ({
//             path: err.path.join("."),
//             message: err.message,
//           })),
//         });
//       }
//       next(error);
//     }
//   };
// };
