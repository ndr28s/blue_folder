# Blue Folder

Windows desktop application built with Capacitor + React/TypeScript.

## Overview

Blue Folder is the Windows desktop client for the Blue platform, providing a native-like Windows application experience using web technologies.

## Tech Stack

- **Framework**: Capacitor (Windows target)
- **UI**: React + TypeScript
- **Build**: Vite
- **Package Manager**: npm

## Getting Started

```bash
npm install
npm run dev
```

## Project Structure

```
blue_folder/
├── src/           # React/TypeScript source
├── public/        # Static assets
├── capacitor.config.ts
├── package.json
└── vite.config.ts
```

## Build

```bash
# Web build
npm run build

# Windows app
npx cap add @capacitor-community/electron
npx cap sync
```
