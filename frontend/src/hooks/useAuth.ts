'use client';
// Thin re-export — all state lives in AuthProvider (single getMe call shared across the tree)
export { useAuthContext as useAuth } from '@/components/providers/AuthProvider';
