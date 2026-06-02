import { z, type ZodTypeAny } from 'zod'

export function schemaToType(schema: ZodTypeAny): string {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape
    return `{ ${Object.entries(shape).map(([key, value]) => `${key}${isOptional(value as ZodTypeAny) ? '?' : ''}: ${schemaToType(unwrap(value as ZodTypeAny))}`).join('; ')} }`
  }
  if (schema instanceof z.ZodArray) return `Array<${schemaToType(schema.element)}>`
  if (schema instanceof z.ZodString) return 'string'
  if (schema instanceof z.ZodNumber) return 'number'
  if (schema instanceof z.ZodBoolean) return 'boolean'
  if (schema instanceof z.ZodEnum) return schema.options.map((v: string) => JSON.stringify(v)).join(' | ')
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value)
  if (schema instanceof z.ZodUnion) return schema.options.map(schemaToType).join(' | ')
  if (schema instanceof z.ZodRecord) return `Record<string, ${schemaToType(schema.valueSchema)}>`
  if (schema instanceof z.ZodNullable) return `${schemaToType(schema.unwrap())} | null`
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return schemaToType(unwrap(schema))
  return 'unknown'
}

function isOptional(schema: ZodTypeAny): boolean {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema.isOptional()
}

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return schema.unwrap()
  if (schema instanceof z.ZodDefault) return schema.removeDefault()
  return schema
}
