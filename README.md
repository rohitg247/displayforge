# Digital Signage Management Suite

A production-ready web application for managing digital signage displays, ambient content, case studies, and branch-level configurations.

## Features

- **Dashboard** — overview of all displays and activity
- **Displays Management** — create, configure, and manage digital signage screens
- **Ambient Displays** — ambient content viewer and editor
- **Case Study Editor** — build and publish case study content
- **Branch Management** — multi-branch support for distributed deployments
- **Display Viewer** — real-time preview of active display content

## Tech Stack

- [React 18](https://react.dev/) — UI framework
- [Vite](https://vitejs.dev/) — build tool and dev server
- [TypeScript](https://www.typescriptlang.org/) — type safety
- [Tailwind CSS](https://tailwindcss.com/) — utility-first styling
- [shadcn/ui](https://ui.shadcn.com/) — component library
- [React Router v6](https://reactrouter.com/) — client-side routing
- [TanStack Query](https://tanstack.com/query) — server state management
- [React Hook Form](https://react-hook-form.com/) + [Zod](https://zod.dev/) — forms and validation
- [Framer Motion](https://www.framer.com/motion/) — animations
- [Recharts](https://recharts.org/) — data visualisation

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm v9 or later

### Installation

```sh
# Clone the repository
git clone <YOUR_GIT_URL>

# Navigate to the project directory
cd <YOUR_PROJECT_NAME>

# Install dependencies
npm install

# Start the development server
npm run dev
```

The app will be available at `http://localhost:5173`.

### Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot-reload |
| `npm run build` | Production build |
| `npm run build:dev` | Development build |
| `npm run preview` | Preview production build locally |
| `npm run lint` | Run ESLint |
| `npm test` | Run test suite |
| `npm run test:watch` | Run tests in watch mode |

## Project Structure

```
src/
├── components/     # Reusable UI components
├── context/        # React context providers
├── data/           # Static data and constants
├── hooks/          # Custom React hooks
├── lib/            # Utility functions
├── pages/          # Page-level components
├── routes/         # Route definitions
└── services/       # API and service layer
```

## Deployment

Build the app for production:

```sh
npm run build
```

The output will be in the `dist/` directory. Deploy it to any static hosting provider (Netlify, Vercel, AWS S3, etc.) or serve it with your own web server.

## Contributing

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm run lint` and `npm test` before committing
4. Open a pull request

## License

Private — all rights reserved.
