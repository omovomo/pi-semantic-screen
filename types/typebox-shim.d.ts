declare module "typebox" {
  type Schema = Record<string, unknown>;
  export const Type: {
    Object(properties: Record<string, Schema>, options?: Record<string, unknown>): Schema;
    String(options?: Record<string, unknown>): Schema;
    Number(options?: Record<string, unknown>): Schema;
    Integer(options?: Record<string, unknown>): Schema;
    Boolean(options?: Record<string, unknown>): Schema;
    Array(items: Schema, options?: Record<string, unknown>): Schema;
    Optional(schema: Schema): Schema;
    Literal(value: string | number | boolean): Schema;
    Union(schemas: Schema[]): Schema;
  };
}
