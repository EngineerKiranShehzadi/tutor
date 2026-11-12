import { gql } from '@apollo/client';

// includeArchived is optional, so every student-facing caller that passes no
// variables keeps getting active lectures only.
export const GET_LECTURES = gql`
  query GetLectures($courseId: Int, $includeArchived: Boolean) {
    lectures(courseId: $courseId, includeArchived: $includeArchived) {
      id
      courseId
      agentName
      title
      description
      youtubeUrl
      youtubeVideoId
      status
      archivedAt
      createdAt
      updatedAt
    }
  }
`;

export const GET_LECTURE = gql`
  query GetLecture($id: String!) {
    lecture(id: $id) {
      id
      courseId
      agentName
      title
      description
      youtubeUrl
      youtubeVideoId
      status
      archivedAt
      progressCurrent
      progressTotal
      createdAt
      updatedAt
    }
  }
`;

export const CREATE_LECTURE_MUTATION = gql`
  mutation CreateLecture($input: CreateLectureInput!) {
    createLecture(input: $input) {
      id
      courseId
      agentName
      title
      status
    }
  }
`;

export const UPDATE_LECTURE_MUTATION = gql`
  mutation UpdateLecture($id: String!, $input: UpdateLectureInput!) {
    updateLecture(id: $id, input: $input) {
      id
      courseId
      agentName
      title
      description
      youtubeUrl
    }
  }
`;

export const DELETE_LECTURE_MUTATION = gql`
  mutation DeleteLecture($id: String!) {
    deleteLecture(id: $id)
  }
`;

export const ARCHIVE_LECTURE_MUTATION = gql`
  mutation ArchiveLecture($id: String!) {
    archiveLecture(id: $id) { id archivedAt }
  }
`;

export const RESTORE_LECTURE_MUTATION = gql`
  mutation RestoreLecture($id: String!) {
    restoreLecture(id: $id) { id archivedAt }
  }
`;
