// Express Request augmentation — profile context set by session middleware
declare namespace Express {
  interface Request {
    profile: {
      id: number;
      email: string;
      displayName: string;  // email part before @
      isAdmin: boolean;
    };
  }
}
