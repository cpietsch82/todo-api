import { PgTableWithColumns, TableConfig } from "drizzle-orm/pg-core";
import { BaseModule } from "./BaseModule";
import { db } from "@/db";
import { eq } from "drizzle-orm";

export class StorageModule<T extends TableConfig> extends BaseModule {
    protected collection: PgTableWithColumns<T>;
    protected idProperty: string;

    constructor(moduleId: string, description: string, collection: PgTableWithColumns<T>, idProperty: string) {
        super(moduleId, description);
        this.collection = collection;
        this.idProperty = idProperty;
    }

    async update(id: string, updateData: Partial<PgTableWithColumns<T>["$inferInsert"]>): Promise<T> {
        const [result] = await db.update(this.collection).set(updateData).where(eq(this.collection[this.idProperty], id)).returning();
        return result as T;
    }

    // getAll(): Promise<T[]> {
    //     return db.query[this.collection].findMany({});
    // }
}

export default StorageModule;