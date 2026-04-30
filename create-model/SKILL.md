---
name: create-model
description: Step-by-step workflow for creating a new Sequelize database model with migration, types, associations, and tests
---

# Database Models Conventions

## Directory Structure

Models live in `server/src/db/models/` with each model in its own directory:

```
server/src/db/models/
├── [modelName].model/
│   ├── [modelName].model.ts      # Main model definition
│   ├── index.ts                   # Re-exports the model
│   └── [modelName].model.test.ts  # Tests (only for complex models)
```

## Creating a New Model

### 1. Create the Migration

Location: `server/src/db/migrations/[timestamp]-[description].js`

Timestamp format: `YYYYMMDDHHMMSS` (e.g., `20260127000001`)

```javascript
"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("tableName", {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
      },
      // ... other fields
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });

    // Add indexes as needed
    await queryInterface.addIndex("tableName", {
      fields: ["fieldName"],
      name: "table_name_field_name",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("tableName");
  },
};
```

### 2. Create the Model File

Location: `server/src/db/models/[modelName].model/[modelName].model.ts`

```typescript
import {
  Association,
  BelongsToGetAssociationMixin,
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from "sequelize";
import sequelize from "../../sequelize";
import RelatedModel from "../relatedModel.model";

class ModelName extends Model<
  InferAttributes<ModelName>,
  InferCreationAttributes<ModelName>
> {
  // Required fields
  declare fieldName: string;

  // Optional fields (auto-generated or with defaults)
  declare id: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  // Association properties (populated when included in queries)
  declare relatedModel?: RelatedModel;

  // Association mixins
  declare getRelatedModel: BelongsToGetAssociationMixin<RelatedModel>;

  // Static associations property
  static associations: {
    relatedModel: Association<ModelName, RelatedModel>;
  };

  // Custom methods (if needed)
  customMethod(): boolean {
    return true;
  }
}

ModelName.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
      allowNull: false,
    },
    fieldName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: "modelName",        // camelCase
    tableName: "tableNames",       // camelCase, plural
  },
);

export default ModelName;
```

### 3. Create the Index File

Location: `server/src/db/models/[modelName].model/index.ts`

```typescript
export { default } from "./modelName.model";
export { default as ModelName } from "./modelName.model";
```

### 4. Register the Model

**In `server/src/db/index.ts`:**
```typescript
// Add import
import ModelName from "./models/modelName.model";

// Add to models object
const models = {
  // ... existing models
  ModelName,
};
```

**In `server/src/db/types.ts`:**
```typescript
// Add import
import ModelName from "./models/modelName.model";

// Add type export
export type ModelNameModelType = typeof ModelName.prototype;
```

**In `server/src/db/associations.ts`:**
```typescript
// Add import
import ModelName from "./models/modelName.model";

// Add associations in initializeAssociations()
ModelName.belongsTo(RelatedModel, {
  foreignKey: "relatedModelId",
  as: "relatedModel",
});
RelatedModel.hasMany(ModelName, {
  foreignKey: "relatedModelId",
});
```

## Model Testing

**Only test complex models** that have:
- Virtual properties
- Custom instance methods
- Hooks (beforeCreate, afterUpdate, etc.)
- Complex validation logic
- Auto-population of fields

Simple models with just data fields don't need tests.

### Test File Location

`server/src/db/models/[modelName].model/[modelName].model.test.ts`

### Test Pattern

```typescript
import { assert } from "chai";
import db, { RelatedModelType } from "../..";
import { createRelatedModel } from "../../../test/testDataGenerator";

describe("ModelName Model", function () {
  let relatedModel: RelatedModelType;

  beforeEach(async function () {
    relatedModel = await createRelatedModel(db);
  });

  describe("customMethod", function () {
    it("returns expected value", async function () {
      const instance = await db.models.ModelName.create({
        relatedModelId: relatedModel.id,
        // ... other required fields
      });

      assert.isTrue(instance.customMethod());
    });
  });

  describe("virtual property", function () {
    it("computes correctly", async function () {
      const instance = await db.models.ModelName.create({
        // ... fields
      });

      assert.equal(instance.virtualProp, expectedValue);
    });
  });
});
```

### Run Model Tests

```bash
make test-server-file GREP="ModelName Model"
```

## Verification Checklist

After creating a model:

- [ ] Migration file created with proper timestamp
- [ ] Model file created with TypeScript types
- [ ] Index file exports the model
- [ ] Model imported in `db/index.ts`
- [ ] Model added to models object in `db/index.ts`
- [ ] Type exported in `db/types.ts`
- [ ] Associations added in `db/associations.ts`
- [ ] `make build-server` passes
- [ ] `make lint-server` passes
- [ ] `make db-migrate-all` runs successfully
- [ ] Tests written (if model has complex logic)

## Common Patterns

### Enum Fields

Define enums as constants for type safety:

```typescript
export const STATUS_VALUES = ["pending", "active", "completed"] as const;
export type StatusType = (typeof STATUS_VALUES)[number];

// In model init:
status: {
  type: DataTypes.ENUM(...STATUS_VALUES),
  allowNull: false,
  defaultValue: "pending",
},
```

### Nullable Foreign Keys

```typescript
relatedModelId: {
  type: DataTypes.UUID,
  allowNull: true,  // nullable FK
  references: {
    model: "relatedModels",
    key: "id",
  },
},
```

### Uppercase Constraint (for codes)

In migration:
```javascript
await queryInterface.sequelize.query(`
  ALTER TABLE "tableName"
  ADD CONSTRAINT "tableName_code_uppercase"
  CHECK (code = UPPER(code))
`);
```
