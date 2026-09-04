## Project Structure

```
homepage/
├── src/
|   ├── db/
|   |   └── schema/
|   |     └── index.ts
|   |   └── index.ts
|   |   └── migrate.ts
│   ├── middleware/
│   │   └── validate.ts         # Global middleware to validate schemas
│   ├── modules/
│   │   └── core/
|   |     └── BaseModule.ts     # Base Class for all Modules
|   |     └── APIModule.ts      # API Module Class to configure Express Routes
│   │   └── todos/
|   |     └── schema/
|   |       └── todo.schema.ts
|   |     └── test/
|   |       └── TodoAPI.test.ts
|   |     └── TodoAPI.ts
|   |     └── TodoService.ts
│   │   └── .../
│   ├── utils/                  # Folder with some Utlity functions
|   |     └── asyncHandler.ts
│   └── index.ts                # Application entry point
├── package.json
├── nodemon.json
├── drizzle.config.ts
├── env.ts
└── README.md
```

## Tech Stack

- **Express JS** - Javascript Express framework
- **TypeScript** - Type-safe JavaScript
- **Pino** - Logging Tool
- **Postgres** - Database
- **Drizzle** - ORM for Database
- **Jose** - JWT Management

## TODOs
