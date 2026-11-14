import { gql } from '@apollo/client';

export const GET_LEARNING_OUTCOMES = gql`
  query CourseLearningOutcomes($courseId:Int!) {
    courseLearningOutcomes(courseId:$courseId) { id courseId code description externalGuid lectureIds }
  }
`;
export const GET_FACULTY_OUTCOME_SUMMARY = gql`
  query FacultyOutcomeSummary($courseId:Int!) {
    facultyOutcomeSummary(courseId:$courseId) { outcomeId code description attempted correct students percent }
  }
`;
export const GET_OUTCOME_QUESTIONS = gql`
  query LearningOutcomeQuestions($courseId:Int!,$limit:Int) {
    learningOutcomeQuestions(courseId:$courseId,limit:$limit) {
      questionId lectureId lectureTitle question outcomeId
    }
  }
`;
export const GET_MY_OUTCOME_PROGRESS = gql`
  query MyOutcomeProgress($courseId:Int!) {
    myOutcomeProgress(courseId:$courseId) {
      outcomeId code description attempted correct percent status
    }
  }
`;
export const CREATE_LEARNING_OUTCOME = gql`
  mutation CreateLearningOutcome($courseId:Int!,$code:String!,$description:String!) {
    createLearningOutcome(courseId:$courseId,code:$code,description:$description) {
      id courseId code description externalGuid lectureIds
    }
  }
`;
export const UPDATE_LEARNING_OUTCOME = gql`
  mutation UpdateLearningOutcome($id:Int!,$description:String!) {
    updateLearningOutcome(id:$id,description:$description) {
      id courseId code description externalGuid lectureIds
    }
  }
`;
export const SET_LECTURE_LEARNING_OUTCOME = gql`
  mutation SetLectureLearningOutcome($courseId:Int!,$lectureId:Int!,$outcomeId:Int!,$selected:Boolean!) {
    setLectureLearningOutcome(courseId:$courseId,lectureId:$lectureId,outcomeId:$outcomeId,selected:$selected) {
      id courseId code description externalGuid lectureIds
    }
  }
`;
export const MAP_PRACTICE_QUESTION_OUTCOME = gql`
  mutation MapPracticeQuestionOutcome($courseId:Int!,$questionId:Int!,$outcomeId:Int!) {
    mapPracticeQuestionOutcome(courseId:$courseId,questionId:$questionId,outcomeId:$outcomeId)
  }
`;
export const UNMAP_PRACTICE_QUESTION_OUTCOME = gql`
  mutation UnmapPracticeQuestionOutcome($courseId:Int!,$questionId:Int!) {
    unmapPracticeQuestionOutcome(courseId:$courseId,questionId:$questionId)
  }
`;
