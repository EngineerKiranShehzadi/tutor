import { gql } from '@apollo/client';
const QUIZ_FIELDS = gql`
  fragment PracticeQuizFields on PracticeQuiz {
    id courseId lectureIds status total correct percent createdAt submittedAt
    questions {id lectureId lectureTitle position category question options selectedIndex correctIndex isCorrect explanation source}
    breakdown {lectureId lectureTitle total correct incorrect recommendation}
  }
`;
export const CREATE_PRACTICE_QUIZ = gql`
  mutation CreatePracticeQuiz($courseId:Int!,$lectureIds:[Int!]!){
    createPracticeQuiz(courseId:$courseId,lectureIds:$lectureIds){...PracticeQuizFields}
  }
  ${QUIZ_FIELDS}
`;
export const RETAKE_PRACTICE_QUIZ = gql`
  mutation RetakePracticeQuiz($id:Int!){retakePracticeQuiz(id:$id){...PracticeQuizFields}}
  ${QUIZ_FIELDS}
`;
export const GET_PRACTICE_QUIZ = gql`
  query MyPracticeQuiz($id:Int!){myPracticeQuiz(id:$id){...PracticeQuizFields}}
  ${QUIZ_FIELDS}
`;
export const SUBMIT_PRACTICE_QUIZ = gql`
  mutation SubmitPracticeQuiz($id:Int!,$answers:[PracticeAnswerInput!]!){
    submitPracticeQuiz(id:$id,answers:$answers){...PracticeQuizFields}
  }
  ${QUIZ_FIELDS}
`;
export const GET_PRACTICE_HISTORY = gql`
  query MyPracticeQuizzes{myPracticeQuizzes{id courseId status total correct percent createdAt submittedAt}}
`;
export const GET_PRACTICE_PROGRESS = gql`
  query MyPracticeProgress{myPracticeProgress{attempts answered correct percent lectures{lectureId lectureTitle total correct percent}}}
`;
