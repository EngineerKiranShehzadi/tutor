'use client';
import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
export default function Redirect() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  useEffect(() => { router.replace(`/admin/lectures/${id}`); }, [router, id]);
  return null;
}
