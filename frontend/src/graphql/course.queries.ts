import { gql } from '@apollo/client';

export const GET_COURSES = gql`
  query GetCourses {
    courses { id title subtitle description lectureCount readyCount createdAt updatedAt }
  }
`;
export const GET_COURSE = gql`
  query GetCourse($id: String!) {
    course(id: $id) { id title subtitle description lectureCount readyCount createdAt updatedAt }
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
