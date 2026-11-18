import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';

const strictBodyCache = new WeakMap<z.ZodTypeAny, z.ZodTypeAny>();

function strictifySchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const cached = strictBodyCache.get(schema);
  if (cached) return cached;

  let result: z.ZodTypeAny = schema;
  if (schema instanceof z.ZodObject) {
    const rawShape = schema._def.shape();
    const nextShape: Record<string, z.ZodTypeAny> = {};
    for (const [key, fieldSchema] of Object.entries(rawShape)) {
      nextShape[key] = strictifySchema(fieldSchema as z.ZodTypeAny);
    }
    result = new z.ZodObject({
      ...schema._def,
      shape: () => nextShape,
      unknownKeys: 'strict',
    });
  } else if (schema instanceof z.ZodEffects) {
    result = new z.ZodEffects({
      ...schema._def,
      schema: strictifySchema(schema._def.schema),
    });
  } else if (schema instanceof z.ZodOptional) {
    result = new z.ZodOptional({
      ...schema._def,
      innerType: strictifySchema(schema._def.innerType),
    });
  } else if (schema instanceof z.ZodNullable) {
    result = new z.ZodNullable({
      ...schema._def,
      innerType: strictifySchema(schema._def.innerType),
    });
  } else if (schema instanceof z.ZodDefault) {
    result = new z.ZodDefault({
      ...schema._def,
      innerType: strictifySchema(schema._def.innerType),
    });
  } else if (schema instanceof z.ZodArray) {
    result = new z.ZodArray({
      ...schema._def,
      type: strictifySchema(schema._def.type),
    });
  } else if (schema instanceof z.ZodRecord) {
    result = new z.ZodRecord({
      ...schema._def,
      valueType: strictifySchema(schema._def.valueType),
    });
  } else if (schema instanceof z.ZodUnion) {
    result = z.union(schema._def.options.map((opt: z.ZodTypeAny) => strictifySchema(opt)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else if (schema instanceof z.ZodDiscriminatedUnion) {
    result = z.discriminatedUnion(
      schema._def.discriminator,
      schema._def.options.map((opt: z.ZodTypeAny) => strictifySchema(opt)) as any
    );
  } else if (schema instanceof z.ZodIntersection) {
    result = z.intersection(strictifySchema(schema._def.left), strictifySchema(schema._def.right));
  }

  strictBodyCache.set(schema, result);
  return result;
}

export interface ValidationTargets {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validate(schemas: ValidationTargets) {
  const strictBodySchema = schemas.body ? strictifySchema(schemas.body) : undefined;
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.params) {
        req.params = await schemas.params.parseAsync(req.params);
      }
      if (schemas.query) {
        req.query = await schemas.query.parseAsync(req.query);
      }
      if (strictBodySchema) {
        req.body = await strictBodySchema.parseAsync(req.body);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
