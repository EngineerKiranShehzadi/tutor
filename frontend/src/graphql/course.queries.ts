import { gql } from '@apollo/client';

// includeArchived is optional, so every existing caller that passes no
// variables keeps getting active courses only.
export const GET_COURSES = gql`
  query GetCourses($includeArchived: Boolean) {
    courses(includeArchived: $includeArchived) {
      id title subtitle description lectureCount readyCount createdAt updatedAt archivedAt
    }
  }
`;
export const GET_COURSE = gql`
  query GetCourse($id: String!) {
    course(id: $id) { id title subtitle description lectureCount readyCount createdAt updatedAt archivedAt }
  }
`;
export const CREATE_COURSE = gql`
  mutation CreateCourse($input: CreateCourseInput!) {
    createCourse(input: $input) { id title subtitle description lectureCount }
  }
`;
export const UPDATE_COURSE = gql`
  mutation UpdateCourse($id: String!, $input: UpdateCourseInput!) {
    updateCourse(id: $id, input: $input) { id title subtitle description lectureCount }
  }
`;
export const ARCHIVE_COURSE = gql`
  mutation ArchiveCourse($id: String!) {
    archiveCourse(id: $id) { id archivedAt }
  }
`;
export const RESTORE_COURSE = gql`
  mutation RestoreCourse($id: String!) {
    restoreCourse(id: $id) { id archivedAt }
  }
`;
export const DELETE_COURSE = gql`
  mutation DeleteCourse($id: String!) {
    deleteCourse(id: $id)
  }
`;
