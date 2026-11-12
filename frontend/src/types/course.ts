export interface DBCourse {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  lectureCount: number;
  readyCount: number;
  createdAt: string;
  updatedAt: string;
  /** Set once the course has been withdrawn from use; null while it is active. */
  archivedAt: string | null;
}
