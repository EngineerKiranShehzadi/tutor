import { gql } from '@apollo/client';

export const GET_LECTURES = gql`
  query GetLectures {
    lectures {
      id
      title
      description
      youtubeUrl
      youtubeVideoId
      status
      createdAt
      updatedAt
    }
  }
`;

export const GET_LECTURE = gql`
  query GetLecture($id: String!) {
    lecture(id: $id) {
      id
      title
      description
      youtubeUrl
      youtubeVideoId
      status
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
      title
      status
    }
  }
`;

export const UPDATE_LECTURE_MUTATION = gql`
  mutation UpdateLecture($id: String!, $input: UpdateLectureInput!) {
    updateLecture(id: $id, input: $input) {
      id
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
